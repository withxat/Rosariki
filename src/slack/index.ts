import type { Logger } from '@guiiai/logg';
import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

import { registerHttpSecret } from '../http';
import type { SlackFileAttachment, SlackMessage, SlackMessageDelete, SlackMessageEdit, SlackReactionEvent, SlackSentMessage, SlackThreadReply, SlackUser } from './types';
import { createEventBus } from '../event-bus';
import type { ImageToTextResolver } from '../media/image-to-text';
import { generateThumbnail } from '../media/thumbnail';
import type { SlackEmojiCatalog } from './emoji-catalog';
import { fetchSlackEmojiCatalog, renderSlackEmojiCatalogXml } from './emoji-catalog';

export interface SlackManagerOptions {
  botToken: string;
  appToken: string;
  signingSecret?: string;
  botUserId?: string;
  imageToText?: ImageToTextResolver;
  imageToTextChatIds?: Set<string>;
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
  onReaction: (handler: (reaction: SlackReactionEvent) => void) => void;
  sendMessage(channel: string, text: string, threadTs?: string): Promise<SlackSentMessage>;
  uploadFiles(channel: string, files: SlackUploadItem[], initialComment?: string, threadTs?: string): Promise<SlackSentMessage>;
  addReaction(channel: string, messageTs: string, reaction: string): Promise<void>;
  removeReaction(channel: string, messageTs: string, reaction: string): Promise<void>;
  updateMessage(channel: string, messageTs: string, text: string): Promise<SlackSentMessage>;
  deleteMessage(channel: string, messageTs: string): Promise<void>;
  readThread(channel: string, threadTs: string, limit?: number): Promise<SlackThreadReply[]>;
  downloadFileById(fileId: string): Promise<Buffer | undefined>;
  botUserId(): string | undefined;
  emojiCatalog(): SlackEmojiCatalog | undefined;
  emojiCatalogXml(): string | undefined;
  client: WebClient;
}

const captureIngressMeta = () => ({
  receivedAtMs: Date.now(),
  utcOffsetMin: -new Date().getTimezoneOffset(),
});

const slackTsToSec = (ts: string): number => Math.floor(Number.parseFloat(ts));

const userCacheKey = (teamId: string | undefined, userId: string) => `${teamId ?? ''}:${userId}`;

const isImageFile = (file: SlackFileAttachment): boolean =>
  (file.mimeType?.startsWith('image/') ?? false)
  && file.mimeType !== 'image/svg+xml';

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
  const reactionBus = createEventBus<SlackReactionEvent>('slack:reaction', logger);
  const userCache = new Map<string, SlackUser>();
  const seenMessages: string[] = [];
  const seenMessageSet = new Set<string>();
  let botUserId = options.botUserId;
  let emojiCatalog: SlackEmojiCatalog | undefined;
  let running = false;

  const toFileAttachment = (file: any): SlackFileAttachment | undefined => {
    const id = file?.id;
    if (!id) return undefined;
    return {
      id,
      name: file.name,
      title: file.title,
      mimeType: file.mimetype,
      fileType: file.filetype,
      urlPrivate: file.url_private_download ?? file.url_private,
      size: file.size,
      width: file.original_w ?? file.width ?? file.thumb_360_w,
      height: file.original_h ?? file.height ?? file.thumb_360_h,
      duration: file.duration_ms != null ? Math.round(file.duration_ms / 1000) : undefined,
    };
  };

  const downloadFile = async (file: SlackFileAttachment): Promise<Buffer | undefined> => {
    if (!file.urlPrivate) return undefined;
    const res = await fetch(file.urlPrivate, {
      headers: { Authorization: `Bearer ${options.botToken}` },
    });
    if (!res.ok) throw new Error(`Slack file download failed (${res.status} ${res.statusText})`);
    return Buffer.from(await res.arrayBuffer());
  };

  const downloadFileById = async (fileId: string): Promise<Buffer | undefined> => {
    const info = await app.client.files.info({ file: fileId });
    const file = toFileAttachment(info.file);
    return file ? await downloadFile(file) : undefined;
  };

  const hydrateFiles = async (chatId: string, text: string, files?: SlackFileAttachment[]) => {
    if (!files || files.length === 0) return;

    const originalBuffers = new Map<SlackFileAttachment, Buffer>();
    await Promise.all(files.map(async file => {
      if (file.thumbnailWebp || !isImageFile(file)) return;
      try {
        const buffer = await downloadFile(file);
        if (!buffer) return;
        originalBuffers.set(file, buffer);
        file.thumbnailWebp = await generateThumbnail(buffer);
      } catch (err) {
        log.withError(err).withFields({ fileId: file.id, chatId }).warn('Failed to generate Slack file thumbnail');
      }
    }));

    if (options.imageToText && (!options.imageToTextChatIds || options.imageToTextChatIds.has(chatId))) {
      await Promise.all(files.map(async file => {
        if (!file.thumbnailWebp) return;
        const thumbnailBuffer = Buffer.from(file.thumbnailWebp, 'base64');
        await options.imageToText!.resolve(thumbnailBuffer, text, originalBuffers.get(file));
      }));
    }
  };

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
    if (!event.channel || !event.ts || event.bot_id) return undefined;
    if (event.subtype && event.subtype !== 'file_share') return undefined;
    const sender = await loadUser(event.user, event.team);
    const files = Array.isArray(event.files)
      ? event.files.map(toFileAttachment).filter((file: SlackFileAttachment | undefined): file is SlackFileAttachment => file != null)
      : undefined;
    const msg: SlackMessage = {
      messageId: event.ts,
      chatId: event.channel,
      sender,
      date: slackTsToSec(event.ts),
      text: event.text ?? '',
      files,
      replyToMessageId: event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined,
      ...captureIngressMeta(),
    };
    await hydrateFiles(msg.chatId, msg.text, msg.files);
    return msg;
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
        const files = Array.isArray(changed.files)
          ? changed.files.map(toFileAttachment).filter((file: SlackFileAttachment | undefined): file is SlackFileAttachment => file != null)
          : undefined;
        await hydrateFiles(changed.channel, changed.text ?? '', files);
        editBus.emit({
          messageId: changed.ts,
          chatId: changed.channel,
          sender,
          date: slackTsToSec(changed.ts),
          editDate: messageEvent.event_ts ? slackTsToSec(messageEvent.event_ts) : Math.floor(Date.now() / 1000),
          text: changed.text ?? '',
          files,
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

  app.event('reaction_added', async ({ event }) => {
    const reactionEvent = event as any;
    try {
      const item = reactionEvent.item;
      if (item?.type !== 'message' || !item.channel || !item.ts) return;
      reactionBus.emit({
        chatId: item.channel,
        messageId: item.ts,
        sender: await loadUser(reactionEvent.user, reactionEvent.team),
        reaction: reactionEvent.reaction,
        operation: 'added',
        ...captureIngressMeta(),
      });
    } catch (err) {
      log.withError(err).error('Failed to handle Slack reaction_added event');
    }
  });

  app.event('reaction_removed', async ({ event }) => {
    const reactionEvent = event as any;
    try {
      const item = reactionEvent.item;
      if (item?.type !== 'message' || !item.channel || !item.ts) return;
      reactionBus.emit({
        chatId: item.channel,
        messageId: item.ts,
        sender: await loadUser(reactionEvent.user, reactionEvent.team),
        reaction: reactionEvent.reaction,
        operation: 'removed',
        ...captureIngressMeta(),
      });
    } catch (err) {
      log.withError(err).error('Failed to handle Slack reaction_removed event');
    }
  });

  app.error(async err => {
    log.withError(err).error('Slack app error');
  });

  const init = async () => {
    if (!botUserId) {
      const auth = await app.client.auth.test();
      botUserId = auth.user_id;
      log.withFields({ botUserId, team: auth.team }).log('Slack authenticated');
    }
    if (!emojiCatalog) {
      emojiCatalog = await fetchSlackEmojiCatalog(app.client, log);
      log.withFields({
        customEmoji: emojiCatalog.totalCustom,
        truncated: emojiCatalog.truncated,
        loadError: emojiCatalog.loadError ?? null,
      }).log('Slack emoji catalog loaded');
    }
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

  const normalizeReactionName = (reaction: string): string =>
    reaction.replace(/^:|:$/g, '');

  const addReaction = async (channel: string, messageTs: string, reaction: string): Promise<void> => {
    await app.client.reactions.add({ channel, timestamp: messageTs, name: normalizeReactionName(reaction) });
  };

  const removeReaction = async (channel: string, messageTs: string, reaction: string): Promise<void> => {
    await app.client.reactions.remove({ channel, timestamp: messageTs, name: normalizeReactionName(reaction) });
  };

  const updateMessage = async (channel: string, messageTs: string, text: string): Promise<SlackSentMessage> => {
    const updated = await app.client.chat.update({
      channel,
      ts: messageTs,
      text,
    });
    const ts = updated.ts ?? messageTs;
    return {
      messageId: ts,
      date: slackTsToSec(ts),
      text: updated.message?.text ?? text,
    };
  };

  const deleteMessage = async (channel: string, messageTs: string): Promise<void> => {
    await app.client.chat.delete({ channel, ts: messageTs });
  };

  const readThread = async (channel: string, threadTs: string, limit = 20): Promise<SlackThreadReply[]> => {
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: Math.min(Math.max(limit, 1), 100),
    });
    const messages = result.messages ?? [];
    return await Promise.all(messages.map(async msg => ({
      messageId: msg.ts ?? '',
      sender: await loadUser(msg.user, msg.team),
      text: msg.text ?? '',
      date: msg.ts ? slackTsToSec(msg.ts) : 0,
    })));
  };

  return {
    init,
    start,
    stop,
    onMessage: messageBus.on,
    onMessageEdit: editBus.on,
    onMessageDelete: deleteBus.on,
    onReaction: reactionBus.on,
    sendMessage,
    uploadFiles,
    addReaction,
    removeReaction,
    updateMessage,
    deleteMessage,
    readThread,
    downloadFileById,
    botUserId: () => botUserId,
    emojiCatalog: () => emojiCatalog,
    emojiCatalogXml: () => emojiCatalog ? renderSlackEmojiCatalogXml(emojiCatalog) : undefined,
    client: app.client,
  };
};

export type { SlackMessage, SlackMessageDelete, SlackMessageEdit, SlackReactionEvent, SlackSentMessage, SlackThreadReply };
