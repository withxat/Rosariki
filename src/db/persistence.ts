import { and, desc, eq, gte } from 'drizzle-orm';

import type { DB } from './client';
import { codec } from './codec';
import { backgroundTasks, compactions, events, imageAltTexts, probeResponsesV2, turnResponsesV2 } from './schema';
import { contentToPlainText } from '../adaptation';
import type {
  CanonicalAttachment,
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalMessageEvent,
  CanonicalServiceEvent,
} from '../adaptation/types';
import type { CompactionSessionMeta, ProbeResponseV2, TurnResponseV2 } from '../driver/types';
import type { ImageAltTextRecord } from '../media/image-to-text';
import type { PipelineEvent } from '../projection/reduce';
import type { RuntimeEvent, RuntimeEventData } from '../runtime-event';
import type { ConversationEntry } from '../unified-api/types';

export const persistEvent = (db: DB, event: PipelineEvent) => {
  const base = {
    chatId: event.chatId,
    type: event.type,
    receivedAtMs: event.receivedAtMs,
    timestampSec: event.timestampSec,
    utcOffsetMin: event.utcOffsetMin,
  };

  if (event.type === 'runtime') {
    const runtimeData: RuntimeEventData = event.kind === 'scheduled_wake'
      ? { kind: 'scheduled_wake', scheduleId: event.scheduleId, instruction: event.instruction }
      : {
        kind: 'task_completed',
        taskId: event.taskId,
        taskType: event.taskType,
        intention: event.intention,
        finalSummary: event.finalSummary,
        hasFullOutput: event.hasFullOutput,
      };
    db.insert(events).values({ ...base, runtimeData }).run();
  } else if (event.type === 'delete') {
    db.insert(events).values({
      ...base,
      messageIds: event.messageIds,
    }).run();
  } else if (event.type === 'service') {
    db.insert(events).values({
      ...base,
      sender: event.actor ?? null,
      senderId: event.actor?.id ?? null,
      serviceAction: event.action,
    }).run();
  } else {
    const plainText = contentToPlainText(event.content);
    db.insert(events).values({
      ...base,
      messageId: event.messageId,
      senderId: event.sender?.id ?? null,
      text: plainText || null,
      sender: event.sender ?? null,
      content: event.content.length > 0 ? event.content : null,
      attachments: event.attachments.length > 0 ? event.attachments : null,
      replyToMessageId: event.type === 'message' ? (event.replyToMessageId ?? null) : null,
      forwardInfo: event.type === 'message' ? (event.forwardInfo ?? null) : null,
      isSelfSent: event.type === 'message' ? (event.isSelfSent ?? null) : null,
    }).run();
  }
};

type EventRow = typeof events.$inferSelect;

// Load the most recent message/edit event for a given message to detect phantom edits.
export const loadLatestMessageContent = (db: DB, chatId: string, messageId: string) =>
  db.select({ text: events.text, content: events.content, attachments: events.attachments })
    .from(events)
    .where(and(
      eq(events.chatId, chatId),
      eq(events.messageId, messageId),
    ))
    .orderBy(desc(events.id))
    .limit(1)
    .get();

const reconstructMessageEvent = (row: EventRow): CanonicalMessageEvent => {
  const event: CanonicalMessageEvent = {
    type: 'message',
    chatId: row.chatId,
    messageId: row.messageId!,
    receivedAtMs: row.receivedAtMs,
    timestampSec: row.timestampSec,
    utcOffsetMin: row.utcOffsetMin,
    content: row.content ?? [],
    attachments: row.attachments ?? [],
  };
  if (row.sender) event.sender = row.sender;
  if (row.replyToMessageId != null) event.replyToMessageId = row.replyToMessageId;
  if (row.forwardInfo) event.forwardInfo = row.forwardInfo;
  if (row.isSelfSent) event.isSelfSent = true;
  return event;
};

const reconstructEditEvent = (row: EventRow): CanonicalEditEvent => {
  const event: CanonicalEditEvent = {
    type: 'edit',
    chatId: row.chatId,
    messageId: row.messageId!,
    receivedAtMs: row.receivedAtMs,
    timestampSec: row.timestampSec,
    utcOffsetMin: row.utcOffsetMin,
    content: row.content ?? [],
    attachments: row.attachments ?? [],
  };
  if (row.sender) event.sender = row.sender;
  return event;
};

const reconstructDeleteEvent = (row: EventRow): CanonicalDeleteEvent => ({
  type: 'delete',
  chatId: row.chatId,
  messageIds: row.messageIds ?? [],
  receivedAtMs: row.receivedAtMs,
  timestampSec: row.timestampSec,
  utcOffsetMin: row.utcOffsetMin,
});

const reconstructServiceEvent = (row: EventRow): CanonicalServiceEvent => {
  const event: CanonicalServiceEvent = {
    type: 'service',
    chatId: row.chatId,
    receivedAtMs: row.receivedAtMs,
    timestampSec: row.timestampSec,
    utcOffsetMin: row.utcOffsetMin,
    action: row.serviceAction!,
  };
  if (row.sender) event.actor = row.sender;
  return event;
};

const reconstructRuntimeEvent = (row: EventRow): RuntimeEvent => {
  const data = row.runtimeData!;
  const base = {
    type: 'runtime' as const,
    chatId: row.chatId,
    receivedAtMs: row.receivedAtMs,
    timestampSec: row.timestampSec,
    utcOffsetMin: row.utcOffsetMin,
  };
  if (data.kind === 'scheduled_wake') {
    return {
      ...base,
      kind: 'scheduled_wake',
      scheduleId: data.scheduleId,
      instruction: data.instruction,
    };
  }
  return {
    ...base,
    kind: 'task_completed',
    taskId: data.taskId,
    taskType: data.taskType,
    intention: data.intention,
    finalSummary: data.finalSummary,
    hasFullOutput: data.hasFullOutput,
  };
};

const reconstructEvent = (row: EventRow): PipelineEvent => {
  switch (row.type) {
  case 'message': return reconstructMessageEvent(row);
  case 'edit': return reconstructEditEvent(row);
  case 'delete': return reconstructDeleteEvent(row);
  case 'service': return reconstructServiceEvent(row);
  case 'runtime': return reconstructRuntimeEvent(row);
  default: throw new Error(`Unknown event type: ${row.type}`);
  }
};

export const loadEvents = (db: DB, chatId: string, afterMs?: number): PipelineEvent[] => {
  const cond = afterMs != null
    ? and(eq(events.chatId, chatId), gte(events.receivedAtMs, afterMs))
    : eq(events.chatId, chatId);
  const rows = db.select().from(events)
    .where(cond)
    .orderBy(events.receivedAtMs, events.id)
    .all();
  return rows.map(reconstructEvent);
};

export const loadKnownChatIds = (db: DB): string[] => {
  const rows = db.selectDistinct({ chatId: events.chatId })
    .from(events)
    .all();
  return rows.map(r => r.chatId);
};

export const persistTurnResponse = async (db: DB, chatId: string, tr: TurnResponseV2): Promise<void> => {
  const entriesJson = await codec.stringify(tr.entries);
  db.insert(turnResponsesV2).values({
    chatId,
    requestedAt: tr.requestedAtMs,
    entries: entriesJson,
    inputTokens: tr.inputTokens,
    outputTokens: tr.outputTokens,
    cacheReadTokens: tr.cacheReadTokens,
    cacheWriteTokens: tr.cacheWriteTokens,
    modelName: tr.modelName,
  }).run();
};

type TurnResponseV2Row = typeof turnResponsesV2.$inferSelect;

const reconstructTurnResponseV2 = async (row: TurnResponseV2Row): Promise<TurnResponseV2> => {
  const entries = await codec.parse(row.entries) as ConversationEntry[];
  return {
    requestedAtMs: row.requestedAt,
    entries,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    modelName: row.modelName,
  };
};

export const loadTurnResponses = async (db: DB, chatId: string, afterMs?: number): Promise<TurnResponseV2[]> => {
  const query = afterMs != null
    ? db.select().from(turnResponsesV2)
        .where(and(eq(turnResponsesV2.chatId, chatId), gte(turnResponsesV2.requestedAt, afterMs)))
    : db.select().from(turnResponsesV2)
        .where(eq(turnResponsesV2.chatId, chatId));

  const rows = query.orderBy(turnResponsesV2.requestedAt, turnResponsesV2.id).all();
  return await Promise.all(rows.map(reconstructTurnResponseV2));
};

// --- Compaction storage (append-only) ---

export const persistCompaction = (db: DB, chatId: string, meta: CompactionSessionMeta) => {
  db.insert(compactions)
    .values({
      chatId,
      oldCursorMs: meta.oldCursorMs,
      newCursorMs: meta.newCursorMs,
      summary: meta.summary,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      cacheReadTokens: meta.cacheReadTokens,
      cacheWriteTokens: meta.cacheWriteTokens,
      createdAt: Date.now(),
    })
    .run();
};

export const loadCompaction = (db: DB, chatId: string): CompactionSessionMeta | null => {
  const row = db.select().from(compactions)
    .where(eq(compactions.chatId, chatId))
    .orderBy(desc(compactions.id))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    oldCursorMs: row.oldCursorMs,
    newCursorMs: row.newCursorMs,
    summary: row.summary,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
  };
};

// --- Probe response storage ---

export const persistProbeResponse = async (db: DB, chatId: string, probe: ProbeResponseV2): Promise<void> => {
  const entriesJson = await codec.stringify(probe.entries);
  db.insert(probeResponsesV2).values({
    chatId,
    requestedAt: probe.requestedAtMs,
    entries: entriesJson,
    inputTokens: probe.inputTokens,
    outputTokens: probe.outputTokens,
    cacheReadTokens: probe.cacheReadTokens,
    cacheWriteTokens: probe.cacheWriteTokens,
    modelName: probe.modelName,
    isActivated: probe.isActivated,
    createdAt: probe.createdAt,
  }).run();
};

export const loadLastProbeTime = (db: DB, chatId: string): number => {
  const row = db.select({ requestedAt: probeResponsesV2.requestedAt })
    .from(probeResponsesV2)
    .where(eq(probeResponsesV2.chatId, chatId))
    .orderBy(desc(probeResponsesV2.id))
    .limit(1)
    .get();
  return row?.requestedAt ?? 0;
};

const reconstructImageAltTextRecord = (row: typeof imageAltTexts.$inferSelect): ImageAltTextRecord => ({
  imageHash: row.imageHash,
  altText: row.altText,
  altTextTokens: row.altTextTokens,
  ...row.stickerSetName && { stickerSetName: row.stickerSetName },
});

export const loadImageAltTextByHash = (db: DB, imageHash: string): ImageAltTextRecord | null => {
  const row = db.select().from(imageAltTexts)
    .where(eq(imageAltTexts.imageHash, imageHash))
    .limit(1)
    .get();
  return row ? reconstructImageAltTextRecord(row) : null;
};

export const persistImageAltText = (db: DB, record: ImageAltTextRecord) => {
  db.insert(imageAltTexts)
    .values({
      imageHash: record.imageHash,
      altText: record.altText,
      altTextTokens: record.altTextTokens,
      stickerSetName: record.stickerSetName ?? null,
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: imageAltTexts.imageHash,
      set: {
        altText: record.altText,
        altTextTokens: record.altTextTokens,
        stickerSetName: record.stickerSetName ?? null,
      },
    })
    .run();
};

/** Update attachments JSON on an existing event row (for backfilling animationHash). */
export const updateEventAttachments = (db: DB, eventId: number, attachments: CanonicalAttachment[]) => {
  db.update(events)
    .set({ attachments })
    .where(eq(events.id, eventId))
    .run();
};

export interface EventWithId {
  id: number;
  event: PipelineEvent;
}

export const loadEventsWithId = (db: DB, chatId: string, afterMs?: number): EventWithId[] => {
  const cond = afterMs != null
    ? and(eq(events.chatId, chatId), gte(events.receivedAtMs, afterMs))
    : eq(events.chatId, chatId);
  const rows = db.select().from(events)
    .where(cond)
    .orderBy(events.receivedAtMs, events.id)
    .all();
  return rows.map(row => ({ id: row.id, event: reconstructEvent(row) }));
};

/** Load attachments for a message from the latest message/edit event (used by download_file tool). */
export const loadMessageAttachments = (db: DB, chatId: string, messageId: string): CanonicalAttachment[] | undefined => {
  const row = db.select({ attachments: events.attachments })
    .from(events)
    .where(and(eq(events.chatId, chatId), eq(events.messageId, messageId)))
    .orderBy(desc(events.id))
    .limit(1)
    .get();
  return row?.attachments ?? undefined;
};

// --- Background tasks storage ---

export type BackgroundTaskRow = typeof backgroundTasks.$inferSelect;

export const insertBackgroundTask = (db: DB, task: {
  sessionId: string;
  typeName: string;
  intention?: string;
  timeoutMs: number;
  params: unknown;
  startedMs: number;
}): number => {
  const result = db.insert(backgroundTasks).values({
    sessionId: task.sessionId,
    typeName: task.typeName,
    intention: task.intention ?? null,
    timeoutMs: task.timeoutMs,
    params: task.params,
    startedMs: task.startedMs,
    lastUpdatedMs: task.startedMs,
  }).run();
  return Number(result.lastInsertRowid);
};

export const loadIncompleteBackgroundTasks = (db: DB): BackgroundTaskRow[] =>
  db.select().from(backgroundTasks)
    .where(eq(backgroundTasks.completed, false))
    .all();

export const updateBackgroundTaskCheckpoint = (db: DB, id: number, checkpoint: unknown, lastUpdatedMs: number) => {
  db.update(backgroundTasks)
    .set({ checkpoint, lastUpdatedMs })
    .where(eq(backgroundTasks.id, id))
    .run();
};

export const markBackgroundTaskCompleted = (db: DB, id: number, finalSummary: string, fullOutputPath: string | null) => {
  db.update(backgroundTasks)
    .set({ completed: true, finalSummary, fullOutputPath, lastUpdatedMs: Date.now() })
    .where(eq(backgroundTasks.id, id))
    .run();
};

export const loadBackgroundTask = (db: DB, id: number): BackgroundTaskRow | undefined =>
  db.select().from(backgroundTasks)
    .where(eq(backgroundTasks.id, id))
    .get();

/** Load completed tasks for a session, newest first (for retention eviction). */
export const loadCompletedBackgroundTasks = (db: DB, sessionId: string): BackgroundTaskRow[] =>
  db.select().from(backgroundTasks)
    .where(and(eq(backgroundTasks.sessionId, sessionId), eq(backgroundTasks.completed, true)))
    .orderBy(desc(backgroundTasks.id))
    .all();
