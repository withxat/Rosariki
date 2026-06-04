import type { Logger } from '@guiiai/logg';
import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

import { registerHttpSecret } from '../http';
import type { SlackMessage, SlackMessageDelete, SlackMessageEdit, SlackSentMessage, SlackUser } from './types';
import { createEventBus } from '../telegram/event-bus';

export interface SlackManagerOptions {
  botToken: string;
  appToken: string;
  signingSecret?: string;
  botUserId?: string;
}

export interface SlackUploadItem {
  buffer: Buffer;
  fileName?: string;
  title?: string;
}

export interface SlackManager {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage: (handler: (msg: SlackMessage) => void) => void;
  onMessageEdit: (handler: (edit: SlackMessageEdit) => void) => void;
  onMessageDelete: (handler: (del: SlackMessageDelete) => void) => void;
  sendMessage(channel: string, text: string, threadTs?: string): Promise<SlackSentMessage>;
  uploadFiles(channel: string, files: SlackUploadItem[], initialComment?: string, threadTs?: string): Promise<SlackSentMessage>;
  botUserId(): string | undefined;
  client: WebClient;
}

const captureIngressMeta = () => ({
  receivedAtMs: Date.now(),
  utcOffsetMin: -new Date().getTimezoneOffset(),
});

const slackTsToSec = (ts: string): number => Math.floor(Number.parseFloat(ts));

const userCacheKey = (teamId: string | undefined, userId: string) => `${teamId ?? ''}:${userId}`;

export const createSlackManager = (options: SlackManagerOptions, logger: Logger): SlackManager => {
  const log = logger.withContext('slack');
  registerHttpSecret(options.botToken);
  registerHttpSecret(options.appToken);
  if (options.signingSecret) registerHttpSecret(options.signingSecret);

  const app = new App({
    token: options.botToken,
    appToken: options.appToken,
    signingSecret: options.signingSecret ?? 'socket-mode',
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  const messageBus = createEventBus<SlackMessage>('slack:message', logger);
  const editBus = createEventBus<SlackMessageEdit>('slack:edit', logger);
  const deleteBus = createEventBus<SlackMessageDelete>('slack:delete', logger);
  const userCache = new Map<string, SlackUser>();
  const seenMessages: string[] = [];
  const seenMessageSet = new Set<string>();
  let botUserId = options.botUserId;
  let running = false;

  const loadUser = async (userId?: string, teamId?: string): Promise<SlackUser | undefined> => {
    if (!userId) return undefined;
    const key = userCacheKey(teamId, userId);
    const cached = userCache.get(key);
    if (cached) return cached;

    try {
      const result = await app.client.users.info({ user: userId });
      const user = result.user;
      const profile = user?.profile;
      const displayName = profile?.display_name && profile.display_name !== ''
        ? profile.display_name
        : (profile?.real_name && profile.real_name !== ''
            ? profile.real_name
            : (user?.real_name && user.real_name !== '' ? user.real_name : (user?.name ?? userId)));
      const mapped: SlackUser = {
        id: userId,
        displayName,
        username: user?.name,
        isBot: user?.is_bot ?? false,
      };
      userCache.set(key, mapped);
      return mapped;
    } catch (err) {
      log.withError(err).withFields({ userId }).warn('Failed to load Slack user profile');
      return { id: userId, displayName: userId, isBot: false };
    }
  };

  const toMessage = async (event: any): Promise<SlackMessage | undefined> => {
    if (!event.channel || !event.ts || event.bot_id || event.subtype) return undefined;
    const sender = await loadUser(event.user, event.team);
    return {
      messageId: event.ts,
      chatId: event.channel,
      sender,
      date: slackTsToSec(event.ts),
      text: event.text ?? '',
      replyToMessageId: event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined,
      ...captureIngressMeta(),
    };
  };

  const emitMessage = (msg: SlackMessage) => {
    const key = `${msg.chatId}:${msg.messageId}`;
    if (seenMessageSet.has(key)) return;
    seenMessageSet.add(key);
    seenMessages.push(key);
    if (seenMessages.length > 10_000) {
      const evicted = seenMessages.shift();
      if (evicted) seenMessageSet.delete(evicted);
    }
    messageBus.emit(msg);
  };

  app.event('message', async ({ event }) => {
    const messageEvent = event as any;
    try {
      if (messageEvent.subtype === 'message_changed') {
        const changed = messageEvent.message;
        if (!changed?.channel || !changed?.ts || changed.bot_id) return;
        const sender = await loadUser(changed.user, changed.team ?? messageEvent.team);
        editBus.emit({
          messageId: changed.ts,
          chatId: changed.channel,
          sender,
          date: slackTsToSec(changed.ts),
          editDate: messageEvent.event_ts ? slackTsToSec(messageEvent.event_ts) : Math.floor(Date.now() / 1000),
          text: changed.text ?? '',
          ...captureIngressMeta(),
        });
        return;
      }

      if (messageEvent.subtype === 'message_deleted') {
        if (!messageEvent.channel || !messageEvent.deleted_ts) return;
        deleteBus.emit({
          chatId: messageEvent.channel,
          messageIds: [messageEvent.deleted_ts],
          ...captureIngressMeta(),
        });
        return;
      }

      const msg = await toMessage(messageEvent);
      if (msg) emitMessage(msg);
    } catch (err) {
      log.withError(err).error('Failed to handle Slack message event');
    }
  });

  app.event('app_mention', async ({ event }) => {
    try {
      const msg = await toMessage(event);
      if (msg) emitMessage(msg);
    } catch (err) {
      log.withError(err).error('Failed to handle Slack app_mention event');
    }
  });

  app.error(async err => {
    log.withError(err).error('Slack app error');
  });

  const init = async () => {
    if (botUserId) return;
    const auth = await app.client.auth.test();
    botUserId = auth.user_id;
    log.withFields({ botUserId, team: auth.team }).log('Slack authenticated');
  };

  const start = async () => {
    await init();
    if (running) return;
    await app.start();
    running = true;
    log.log('Slack Socket Mode started');
  };

  const stop = async () => {
    if (!running) return;
    await app.stop();
    running = false;
    log.log('Slack stopped');
  };

  const sendMessage = async (channel: string, text: string, threadTs?: string): Promise<SlackSentMessage> => {
    const sent = await app.client.chat.postMessage({
      channel,
      text,
      mrkdwn: true,
      thread_ts: threadTs,
    });
    const ts = sent.ts ?? sent.message?.ts;
    if (!ts) throw new Error('Slack did not return a message timestamp');
    return {
      messageId: ts,
      date: slackTsToSec(ts),
      text: sent.message?.text ?? text,
    };
  };

  const uploadFiles = async (
    channel: string,
    files: SlackUploadItem[],
    initialComment?: string,
    threadTs?: string,
  ): Promise<SlackSentMessage> => {
    if (files.length === 0) return await sendMessage(channel, initialComment ?? '', threadTs);
    await app.client.filesUploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      initial_comment: initialComment,
      file_uploads: files.map(file => ({
        file: file.buffer,
        filename: file.fileName,
        title: file.title ?? file.fileName,
      })),
    });
    const fallback = initialComment && initialComment !== ''
      ? initialComment
      : files.map(file => file.fileName ?? 'attachment').join(', ');
    return {
      messageId: String(Date.now() / 1000),
      date: Math.floor(Date.now() / 1000),
      text: fallback,
    };
  };

  return {
    init,
    start,
    stop,
    onMessage: messageBus.on,
    onMessageEdit: editBus.on,
    onMessageDelete: deleteBus.on,
    sendMessage,
    uploadFiles,
    botUserId: () => botUserId,
    client: app.client,
  };
};

export type { SlackMessage, SlackMessageDelete, SlackMessageEdit, SlackSentMessage };
