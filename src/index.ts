import { execFile } from 'node:child_process';

import { contentToPlainText } from './adaptation';
import { createBackgroundTaskManager } from './background-task';
import { shellTaskFactory } from './background-task/shell';
import { getChatIds, loadConfig, resolveBackgroundTasks, resolveChatConfig, resolveModel, resolveRuntime } from './config/config';
import { setupLogger, useLogger } from './config/logger';
import { loadContacts } from './contacts';
import { cancelScheduledWake, createDatabase, insertScheduledWake, listScheduledWakesForChat, loadCompaction, loadEvents, loadImageAltTextByHash, loadKnownChatIds, loadLastProbeTime, loadLatestMessageContent, loadMessageAttachments, loadTurnResponses, migrateV1ToV2, persistCompaction, persistEvent, persistImageAltText, persistProbeResponse, persistTurnResponse, runMigrations } from './db';
import { createScheduledWakeScheduler } from './scheduler';
import { createDriver } from './driver';
import { computeThumbnailHash, createImageToTextResolver } from './media/image-to-text';
import { createPipeline } from './pipeline';
import type { RenderParams } from './rendering';
import { createSlackManager } from './slack';
import { adaptSlackDelete, adaptSlackEdit, adaptSlackMessage, adaptSlackReaction } from './slack/adapter';
import { isConfiguredChat, selectStartupReplayChatIds } from './startup';

setupLogger();

const logger = useLogger('cahciua');

const main = async () => {
  const config = loadConfig();
  const runtimeConfig = resolveRuntime(config);
  const backgroundTasksConfig = resolveBackgroundTasks(config);

  const chatIds = getChatIds(config);
  const configuredChatIds = new Set(chatIds);
  const slackConfig = config.slack;
  if (!slackConfig?.botToken || !slackConfig.appToken)
    throw new Error('slack.botToken and slack.appToken are required');

  if (runtimeConfig.shell.length === 0)
    throw new Error('runtime.shell must be configured');
  if (!runtimeConfig.writeFile || runtimeConfig.writeFile.length === 0)
    throw new Error('runtime.writeFile must be configured');
  if (!runtimeConfig.readFile || runtimeConfig.readFile.length === 0)
    throw new Error('runtime.readFile must be configured');

  const imageToTextChatIds = new Set(
    chatIds.filter(id => resolveChatConfig(config, id).imageToText.enabled),
  );

  const defaultChatConfig = resolveChatConfig(config, 'default');
  if (imageToTextChatIds.size > 0 && !defaultChatConfig.imageToText.model)
    throw new Error('imageToText.model is required when imageToText.enabled=true (in chats.default or per-chat override)');

  const db = createDatabase(config.database.path, logger);
  runMigrations(db, logger);
  await migrateV1ToV2(db, logger);

  const imageToTextResolver = createImageToTextResolver({
    enabled: imageToTextChatIds.size > 0,
    model: defaultChatConfig.imageToText.model ? resolveModel(config, defaultChatConfig.imageToText.model) : undefined,
    logger,
    lookupByHash: imageHash => loadImageAltTextByHash(db, imageHash),
    persist: record => persistImageAltText(db, record),
  });

  const hydrateAltTextFromCache = (event: import('./projection/reduce').PipelineEvent) => {
    if (event.type !== 'message' && event.type !== 'edit') return;
    for (const att of event.attachments) {
      if (att.altText || !att.thumbnailWebp || !imageToTextChatIds.has(event.chatId)) continue;
      const cached = loadImageAltTextByHash(db, computeThumbnailHash(att.thumbnailWebp));
      if (cached) att.altText = cached.altText;
    }
  };

  const knownChatIds = loadKnownChatIds(db);

  const slack = createSlackManager({
    botToken: slackConfig.botToken,
    appToken: slackConfig.appToken,
    signingSecret: slackConfig.signingSecret,
    botUserId: slackConfig.botUserId,
    imageToText: imageToTextChatIds.size > 0 ? imageToTextResolver : undefined,
    imageToTextChatIds,
  }, logger);

  await slack.init();

  const contactNames = loadContacts(logger);
  const pipeline = createPipeline((_chatId): RenderParams => ({
    botUserId: slack.botUserId(),
    contactNames,
  }));

  const replayChatIds = selectStartupReplayChatIds(knownChatIds, chatIds);
  logger.withFields({ knownSessions: knownChatIds.length, replaySessions: replayChatIds.length }).log('Startup chat selection');

  for (const chatId of replayChatIds) {
    const compaction = loadCompaction(db, chatId);
    if (compaction)
      pipeline.setCompactCursor(chatId, compaction.newCursorMs);
    const events = loadEvents(db, chatId, compaction?.newCursorMs);

    if (imageToTextChatIds.has(chatId)) {
      const tasks: Promise<void>[] = [];
      for (const event of events) {
        if ((event.type === 'message' || event.type === 'edit') && event.attachments.length > 0) {
          const caption = contentToPlainText(event.content);
          tasks.push(imageToTextResolver.hydrateCanonicalAttachments(event.attachments, caption));
        }
      }
      if (tasks.length > 0) await Promise.all(tasks);
    }
    for (const event of events) hydrateAltTextFromCache(event);
    pipeline.replayChat(chatId, events);
  }
  logger.withFields({ sessions: pipeline.getChatIds().length }).log('Cold start complete');

  const readWorkspaceFile = (path: string): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      const cmd = runtimeConfig.readFile;
      const child = execFile(
        cmd[0]!,
        [...cmd.slice(1), path],
        { timeout: 60_000, maxBuffer: runtimeConfig.readFileSizeLimit + 1024, encoding: 'buffer' as BufferEncoding },
        (error, stdout) => {
          if (error) return reject(new Error(`readFile failed: ${error.message}`));
          const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
          if (buf.length > runtimeConfig.readFileSizeLimit)
            return reject(new Error(`File too large: ${buf.length} bytes exceeds limit of ${runtimeConfig.readFileSizeLimit} bytes`));
          resolve(buf);
        },
      );
      child.stdin?.end();
    });

  const injectSyntheticSlackEvent = (chatId: string, sent: { messageId: string; date: number; text: string }, replyToMessageId?: string) => {
    const slackBotUserId = slack.botUserId() ?? 'slack-bot';
    const event = adaptSlackMessage({
      messageId: sent.messageId,
      chatId,
      sender: {
        id: slackBotUserId,
        displayName: 'Cahciua',
        isBot: true,
      },
      date: sent.date,
      text: sent.text,
      replyToMessageId,
    });
    event.isSelfSent = true;

    persistEvent(db, event);
    if (isConfiguredChat(configuredChatIds, chatId))
      pipeline.pushEvent(chatId, event);
  };

  const slackBotSender = () => ({
    id: slack.botUserId() ?? 'slack-bot',
    displayName: 'Cahciua',
    isBot: true,
  });

  const injectSyntheticSlackEdit = (chatId: string, sent: { messageId: string; date: number; text: string }) => {
    const event = adaptSlackEdit({
      messageId: sent.messageId,
      chatId,
      sender: slackBotSender(),
      date: sent.date,
      editDate: Math.floor(Date.now() / 1000),
      text: sent.text,
    });

    persistEvent(db, event);
    if (isConfiguredChat(configuredChatIds, chatId))
      pipeline.pushEvent(chatId, event);
  };

  const injectSyntheticSlackDelete = (chatId: string, messageId: string) => {
    const event = adaptSlackDelete({
      chatId,
      messageIds: [messageId],
      receivedAtMs: Date.now(),
      utcOffsetMin: -new Date().getTimezoneOffset(),
    });

    persistEvent(db, event);
    if (isConfiguredChat(configuredChatIds, chatId))
      pipeline.pushEvent(chatId, event);
  };

  const driverRef: { handleEvent?: (chatId: string, rc: import('./rendering/types').RenderedContext) => void } = {};
  const backgroundTaskManager = createBackgroundTaskManager({
    db,
    persistEvent: event => persistEvent(db, event),
    pushPipelineEvent: (chatId, event) => isConfiguredChat(configuredChatIds, chatId) ? pipeline.pushEvent(chatId, event) : [],
    handleDriverEvent: (chatId, rc) => driverRef.handleEvent?.(chatId, rc),
    taskOutputDir: backgroundTasksConfig.outputDir,
    retentionCount: backgroundTasksConfig.retentionCount,
    logger,
  });
  backgroundTaskManager.registerFactory(shellTaskFactory);
  backgroundTaskManager.recoverTasks();

  const driver = createDriver({
    chatIds,
    resolveChatConfig: id => resolveChatConfig(config, id),
  }, {
    loadTurnResponses: (chatId, afterMs) => loadTurnResponses(db, chatId, afterMs),
    persistTurnResponse: (chatId, tr) => persistTurnResponse(db, chatId, tr),
    persistProbeResponse: (chatId, probe) => persistProbeResponse(db, chatId, probe),
    sendMessage: async (chatId, text, replyToMessageId, attachments) => {
      if (!attachments || attachments.length === 0) {
        const sent = await slack.sendMessage(chatId, text, replyToMessageId);
        injectSyntheticSlackEvent(chatId, sent, replyToMessageId);
        return sent;
      }

      const buffers = await Promise.all(
        attachments.map(att => readWorkspaceFile(att.path)),
      );
      const sent = await slack.uploadFiles(
        chatId,
        attachments.map((att, i) => ({
          buffer: buffers[i]!,
          fileName: att.file_name,
          title: att.file_name,
        })),
        text || undefined,
        replyToMessageId,
      );
      injectSyntheticSlackEvent(chatId, sent, replyToMessageId);
      return sent;
    },
    chatInteractions: chatId => ({
      reactToMessage: async (messageId, reaction, operation) => {
        if (operation === 'add') await slack.addReaction(chatId, messageId, reaction);
        else await slack.removeReaction(chatId, messageId, reaction);
      },
      updateMessage: async (messageId, text) => {
        const sent = await slack.updateMessage(chatId, messageId, text);
        injectSyntheticSlackEdit(chatId, sent);
        return { messageId: sent.messageId };
      },
      deleteMessage: async messageId => {
        await slack.deleteMessage(chatId, messageId);
        injectSyntheticSlackDelete(chatId, messageId);
      },
      readThread: async (messageId, limit) => {
        const replies = await slack.readThread(chatId, messageId, limit);
        return replies.map(reply => ({
          message_id: reply.messageId,
          sender: reply.sender?.displayName ?? reply.sender?.id ?? null,
          text: reply.text,
          date: reply.date,
        }));
      },
    }),
    loadCompaction: chatId => loadCompaction(db, chatId),
    loadLastProbeTime: chatId => loadLastProbeTime(db, chatId),
    persistCompaction: (chatId, meta) => persistCompaction(db, chatId, meta),
    setCompactCursor: (chatId, cursorMs) => pipeline.setCompactCursor(chatId, cursorMs),
    getChatTitle: chatId => pipeline.getIC(chatId)?.chatTitle,
    runtimeConfig,
    loadMessageAttachments: (chatId, messageId) => loadMessageAttachments(db, chatId, messageId),
    downloadPlatformFile: fileId => slack.downloadFileById(fileId),
    getSlackEmojiCatalogXml: () => slack.emojiCatalogXml(),
    resolveModel: name => resolveModel(config, name),
    backgroundTask: {
      startTask: (typeName, sessionId, params, intention, timeoutMs) =>
        backgroundTaskManager.startTask(typeName, sessionId, params, intention, timeoutMs),
      killTask: taskId => backgroundTaskManager.killTask(taskId, 'tool_call'),
      getActiveTasks: sessionId => backgroundTaskManager.getActiveTasks(sessionId),
      readTaskOutput: (taskId, offset, limit) => backgroundTaskManager.readTaskOutput(taskId, offset, limit),
    },
    schedule: chatId => ({
      createSchedule: ({ runAtMs, instruction, repeatEverySec }) =>
        insertScheduledWake(db, {
          chatId,
          runAtMs,
          instruction,
          repeatIntervalMs: repeatEverySec != null ? repeatEverySec * 1000 : undefined,
        }),
      listSchedules: () => listScheduledWakesForChat(db, chatId).map(row => ({
        id: row.id,
        run_at_ms: row.runAtMs,
        instruction: row.instruction,
        repeat_every_sec: row.repeatIntervalMs != null ? Math.round(row.repeatIntervalMs / 1000) : null,
        created_at_ms: row.createdAtMs,
      })),
      cancelSchedule: scheduleId => cancelScheduledWake(db, chatId, scheduleId),
    }),
    logger,
  });

  driverRef.handleEvent = driver.handleEvent;

  createScheduledWakeScheduler({
    db,
    configuredChatIds,
    persistEvent: event => persistEvent(db, event),
    pushPipelineEvent: (chatId, event) => isConfiguredChat(configuredChatIds, chatId) ? pipeline.pushEvent(chatId, event) : undefined,
    handleDriverEvent: (chatId, rc) => driver.handleEvent(chatId, rc),
    logger,
  });

  logger.withFields({ chatIds }).log('Driver initialized');

  for (const chatId of pipeline.getChatIds()) {
    const rc = pipeline.getRC(chatId);
    if (rc) driver.handleEvent(chatId, rc);
  }

  slack.onMessage(msg => {
    logger.withFields({
      source: 'slack',
      chatId: msg.chatId,
      messageId: msg.messageId,
      sender: msg.sender?.username ?? msg.sender?.displayName ?? msg.sender?.id ?? 'unknown',
      text: msg.text.length > 100 ? `${msg.text.slice(0, 100)}...` : msg.text,
      length: msg.text.length,
    }).log('Slack message received');

    const event = adaptSlackMessage(msg);
    persistEvent(db, event);

    if (isConfiguredChat(configuredChatIds, event.chatId)) {
      hydrateAltTextFromCache(event);
      const rc = pipeline.pushEvent(event.chatId, event);
      driver.handleEvent(event.chatId, rc);
    }
  });

  slack.onMessageEdit(edit => {
    logger.withFields({
      source: 'slack',
      chatId: edit.chatId,
      messageId: edit.messageId,
      sender: edit.sender?.username ?? edit.sender?.displayName ?? edit.sender?.id ?? 'unknown',
      text: edit.text.length > 100 ? `${edit.text.slice(0, 100)}...` : edit.text,
      length: edit.text.length,
    }).log('Slack message edited');

    const event = adaptSlackEdit(edit);
    const prev = loadLatestMessageContent(db, event.chatId, event.messageId);
    if (prev) {
      const newText = contentToPlainText(event.content) || null;
      const newContent = event.content.length > 0 ? event.content : null;
      if (prev.text === newText && JSON.stringify(prev.content) === JSON.stringify(newContent)) {
        logger.withFields({ chatId: edit.chatId, messageId: edit.messageId }).log('Slack phantom edit skipped (content unchanged)');
        return;
      }
    }

    persistEvent(db, event);

    if (isConfiguredChat(configuredChatIds, event.chatId)) {
      hydrateAltTextFromCache(event);
      const rc = pipeline.pushEvent(event.chatId, event);
      driver.handleEvent(event.chatId, rc);
    }
  });

  slack.onMessageDelete(del => {
    logger.withFields({
      source: 'slack',
      chatId: del.chatId,
      messageIds: del.messageIds,
    }).log('Slack message deleted');

    const event = adaptSlackDelete(del);
    persistEvent(db, event);

    if (isConfiguredChat(configuredChatIds, event.chatId)) {
      const rc = pipeline.pushEvent(event.chatId, event);
      driver.handleEvent(event.chatId, rc);
    }
  });

  slack.onReaction(reaction => {
    logger.withFields({
      source: 'slack',
      chatId: reaction.chatId,
      messageId: reaction.messageId,
      reaction: reaction.reaction,
      operation: reaction.operation,
      sender: reaction.sender?.username ?? reaction.sender?.displayName ?? reaction.sender?.id ?? 'unknown',
    }).log('Slack reaction changed');

    const event = adaptSlackReaction(reaction);
    persistEvent(db, event);

    if (isConfiguredChat(configuredChatIds, event.chatId)) {
      const rc = pipeline.pushEvent(event.chatId, event);
      driver.handleEvent(event.chatId, rc);
    }
  });

  const shutdown = async () => {
    logger.log('Shutting down...');
    backgroundTaskManager.shutdown();
    driver.stop();
    await slack.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await slack.start();
  logger.log('Cahciua is running');
};

main().catch(err => {
  logger.withError(err).error('Fatal error');
  process.exit(1);
});
