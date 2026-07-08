import type {
	CanonicalAttachment,
	CanonicalDeleteEvent,
	CanonicalEditEvent,
	CanonicalMessageEvent,
	CanonicalServiceEvent,
} from '../adaptation/types'
import type { CompactionSessionMeta, ProbeResponseV2, TurnResponseV2 } from '../driver/types'
import type { ImageAltTextRecord } from '../media/image-to-text'
import type { PipelineEvent } from '../projection/reduce'
import type { RuntimeEvent, RuntimeEventData } from '../runtime-event'
import type { ConversationEntry } from '../unified-api/types'
import type { DB } from './client'

import { and, desc, eq, gte } from 'drizzle-orm'

import { contentToPlainText } from '../adaptation'
import { codec } from './codec'
import { backgroundTasks, compactions, events, imageAltTexts, probeResponsesV2, turnResponsesV2 } from './schema'

export function persistEvent(db: DB, event: PipelineEvent) {
	const base = {
		chatId: event.chatId,
		receivedAtMs: event.receivedAtMs,
		timestampSec: event.timestampSec,
		type: event.type,
		utcOffsetMin: event.utcOffsetMin,
	}

	if (event.type === 'runtime') {
		let runtimeData: RuntimeEventData
		switch (event.kind) {
			case 'schedule_triggered':
				runtimeData = {
					instruction: event.instruction,
					kind: 'schedule_triggered',
					scheduleId: event.scheduleId,
					...(event.scheduleName != null ? { scheduleName: event.scheduleName } : {}),
				}
				break
			case 'task_completed':
				runtimeData = {
					finalSummary: event.finalSummary,
					hasFullOutput: event.hasFullOutput,
					intention: event.intention,
					kind: 'task_completed',
					taskId: event.taskId,
					taskType: event.taskType,
				}
				break
		}
		db.insert(events).values({ ...base, runtimeData }).run()
	}
	else if (event.type === 'delete') {
		db.insert(events).values({
			...base,
			messageIds: event.messageIds,
		}).run()
	}
	else if (event.type === 'service') {
		db.insert(events).values({
			...base,
			sender: event.actor ?? null,
			senderId: event.actor?.id ?? null,
			serviceAction: event.action,
		}).run()
	}
	else {
		const plainText = contentToPlainText(event.content)
		db.insert(events).values({
			...base,
			attachments: event.attachments.length > 0 ? event.attachments : null,
			content: event.content.length > 0 ? event.content : null,
			forwardInfo: event.type === 'message' ? (event.forwardInfo ?? null) : null,
			isSelfSent: event.type === 'message' ? (event.isSelfSent ?? null) : null,
			messageId: event.messageId,
			replyToMessageId: event.type === 'message' ? (event.replyToMessageId ?? null) : null,
			sender: event.sender ?? null,
			senderId: event.sender?.id ?? null,
			text: plainText || null,
		}).run()
	}
}

type EventRow = typeof events.$inferSelect

// Load the most recent message/edit event for a given message to detect phantom edits.
export function loadLatestMessageContent(db: DB, chatId: string, messageId: string) {
	return db.select({ attachments: events.attachments, content: events.content, text: events.text })
		.from(events)
		.where(and(
			eq(events.chatId, chatId),
			eq(events.messageId, messageId),
		))
		.orderBy(desc(events.id))
		.limit(1)
		.get()
}

export function loadEventMessageSenderId(db: DB, chatId: string, messageId: string): string | undefined {
	const row = db.select({ sender: events.sender, senderId: events.senderId })
		.from(events)
		.where(and(
			eq(events.chatId, chatId),
			eq(events.messageId, messageId),
		))
		.orderBy(desc(events.id))
		.limit(1)
		.get()

	if (!row)
		return undefined
	if (row.senderId)
		return row.senderId
	return row.sender?.id
}

function reconstructMessageEvent(row: EventRow): CanonicalMessageEvent {
	const event: CanonicalMessageEvent = {
		attachments: row.attachments ?? [],
		chatId: row.chatId,
		content: row.content ?? [],
		messageId: row.messageId!,
		receivedAtMs: row.receivedAtMs,
		timestampSec: row.timestampSec,
		type: 'message',
		utcOffsetMin: row.utcOffsetMin,
	}
	if (row.sender)
		event.sender = row.sender
	if (row.replyToMessageId != null)
		event.replyToMessageId = row.replyToMessageId
	if (row.forwardInfo)
		event.forwardInfo = row.forwardInfo
	if (row.isSelfSent)
		event.isSelfSent = true
	return event
}

function reconstructEditEvent(row: EventRow): CanonicalEditEvent {
	const event: CanonicalEditEvent = {
		attachments: row.attachments ?? [],
		chatId: row.chatId,
		content: row.content ?? [],
		messageId: row.messageId!,
		receivedAtMs: row.receivedAtMs,
		timestampSec: row.timestampSec,
		type: 'edit',
		utcOffsetMin: row.utcOffsetMin,
	}
	if (row.sender)
		event.sender = row.sender
	return event
}

function reconstructDeleteEvent(row: EventRow): CanonicalDeleteEvent {
	return {
		chatId: row.chatId,
		messageIds: row.messageIds ?? [],
		receivedAtMs: row.receivedAtMs,
		timestampSec: row.timestampSec,
		type: 'delete',
		utcOffsetMin: row.utcOffsetMin,
	}
}

function reconstructServiceEvent(row: EventRow): CanonicalServiceEvent {
	const event: CanonicalServiceEvent = {
		action: row.serviceAction!,
		chatId: row.chatId,
		receivedAtMs: row.receivedAtMs,
		timestampSec: row.timestampSec,
		type: 'service',
		utcOffsetMin: row.utcOffsetMin,
	}
	if (row.sender)
		event.actor = row.sender
	return event
}

function reconstructRuntimeEvent(row: EventRow): RuntimeEvent {
	const data = row.runtimeData!
	const base = {
		chatId: row.chatId,
		receivedAtMs: row.receivedAtMs,
		timestampSec: row.timestampSec,
		type: 'runtime' as const,
		utcOffsetMin: row.utcOffsetMin,
	}
	switch (data.kind) {
		case 'schedule_triggered':
			return {
				...base,
				instruction: data.instruction,
				kind: 'schedule_triggered',
				scheduleId: data.scheduleId,
				scheduleName: data.scheduleName,
			}
		case 'task_completed':
			return {
				...base,
				finalSummary: data.finalSummary,
				hasFullOutput: data.hasFullOutput,
				intention: data.intention,
				kind: 'task_completed',
				taskId: data.taskId,
				taskType: data.taskType,
			}
	}
}

function reconstructEvent(row: EventRow): PipelineEvent {
	switch (row.type) {
		case 'message': return reconstructMessageEvent(row)
		case 'edit': return reconstructEditEvent(row)
		case 'delete': return reconstructDeleteEvent(row)
		case 'service': return reconstructServiceEvent(row)
		case 'runtime': return reconstructRuntimeEvent(row)
		default: throw new Error(`Unknown event type: ${row.type}`)
	}
}

export function loadEvents(db: DB, chatId: string, afterMs?: number): PipelineEvent[] {
	const cond = afterMs != null
		? and(eq(events.chatId, chatId), gte(events.receivedAtMs, afterMs))
		: eq(events.chatId, chatId)
	const rows = db.select().from(events).where(cond).orderBy(events.receivedAtMs, events.id).all()
	return rows.map(reconstructEvent)
}

export function loadKnownChatIds(db: DB): string[] {
	const rows = db.selectDistinct({ chatId: events.chatId })
		.from(events)
		.all()
	return rows.map(r => r.chatId)
}

export async function persistTurnResponse(db: DB, chatId: string, tr: TurnResponseV2): Promise<void> {
	const entriesJson = await codec.stringify(tr.entries)
	db.insert(turnResponsesV2).values({
		cacheReadTokens: tr.cacheReadTokens,
		cacheWriteTokens: tr.cacheWriteTokens,
		chatId,
		entries: entriesJson,
		inputTokens: tr.inputTokens,
		modelName: tr.modelName,
		outputTokens: tr.outputTokens,
		requestedAt: tr.requestedAtMs,
	}).run()
}

type TurnResponseV2Row = typeof turnResponsesV2.$inferSelect

async function reconstructTurnResponseV2(row: TurnResponseV2Row): Promise<TurnResponseV2> {
	const entries = await codec.parse(row.entries) as ConversationEntry[]
	return {
		cacheReadTokens: row.cacheReadTokens,
		cacheWriteTokens: row.cacheWriteTokens,
		entries,
		inputTokens: row.inputTokens,
		modelName: row.modelName,
		outputTokens: row.outputTokens,
		requestedAtMs: row.requestedAt,
	}
}

export async function loadTurnResponses(db: DB, chatId: string, afterMs?: number): Promise<TurnResponseV2[]> {
	const query = afterMs != null
		? db.select().from(turnResponsesV2).where(and(eq(turnResponsesV2.chatId, chatId), gte(turnResponsesV2.requestedAt, afterMs)))
		: db.select().from(turnResponsesV2).where(eq(turnResponsesV2.chatId, chatId))

	const rows = query.orderBy(turnResponsesV2.requestedAt, turnResponsesV2.id).all()
	return await Promise.all(rows.map(reconstructTurnResponseV2))
}

// --- Compaction storage (append-only) ---

export function persistCompaction(db: DB, chatId: string, meta: CompactionSessionMeta) {
	db.insert(compactions)
		.values({
			cacheReadTokens: meta.cacheReadTokens,
			cacheWriteTokens: meta.cacheWriteTokens,
			chatId,
			createdAt: Date.now(),
			inputTokens: meta.inputTokens,
			newCursorMs: meta.newCursorMs,
			oldCursorMs: meta.oldCursorMs,
			outputTokens: meta.outputTokens,
			summary: meta.summary,
		})
		.run()
}

export function loadCompaction(db: DB, chatId: string): CompactionSessionMeta | null {
	const row = db.select().from(compactions).where(eq(compactions.chatId, chatId)).orderBy(desc(compactions.id)).limit(1).get()
	if (!row)
		return null
	return {
		cacheReadTokens: row.cacheReadTokens,
		cacheWriteTokens: row.cacheWriteTokens,
		inputTokens: row.inputTokens,
		newCursorMs: row.newCursorMs,
		oldCursorMs: row.oldCursorMs,
		outputTokens: row.outputTokens,
		summary: row.summary,
	}
}

// --- Probe response storage ---

export async function persistProbeResponse(db: DB, chatId: string, probe: ProbeResponseV2): Promise<void> {
	const entriesJson = await codec.stringify(probe.entries)
	db.insert(probeResponsesV2).values({
		cacheReadTokens: probe.cacheReadTokens,
		cacheWriteTokens: probe.cacheWriteTokens,
		chatId,
		createdAt: probe.createdAt,
		entries: entriesJson,
		inputTokens: probe.inputTokens,
		isActivated: probe.isActivated,
		modelName: probe.modelName,
		outputTokens: probe.outputTokens,
		requestedAt: probe.requestedAtMs,
	}).run()
}

export function loadLastProbeTime(db: DB, chatId: string): number {
	const row = db.select({ requestedAt: probeResponsesV2.requestedAt })
		.from(probeResponsesV2)
		.where(eq(probeResponsesV2.chatId, chatId))
		.orderBy(desc(probeResponsesV2.id))
		.limit(1)
		.get()
	return row?.requestedAt ?? 0
}

function reconstructImageAltTextRecord(row: typeof imageAltTexts.$inferSelect): ImageAltTextRecord {
	return {
		altText: row.altText,
		altTextTokens: row.altTextTokens,
		imageHash: row.imageHash,
		...row.stickerSetName && { stickerSetName: row.stickerSetName },
	}
}

export function loadImageAltTextByHash(db: DB, imageHash: string): ImageAltTextRecord | null {
	const row = db.select().from(imageAltTexts).where(eq(imageAltTexts.imageHash, imageHash)).limit(1).get()
	return row ? reconstructImageAltTextRecord(row) : null
}

export function persistImageAltText(db: DB, record: ImageAltTextRecord) {
	db.insert(imageAltTexts)
		.values({
			altText: record.altText,
			altTextTokens: record.altTextTokens,
			createdAt: Date.now(),
			imageHash: record.imageHash,
			stickerSetName: record.stickerSetName ?? null,
		})
		.onConflictDoUpdate({
			set: {
				altText: record.altText,
				altTextTokens: record.altTextTokens,
				stickerSetName: record.stickerSetName ?? null,
			},
			target: imageAltTexts.imageHash,
		})
		.run()
}

/** Update attachments JSON on an existing event row (for backfilling animationHash). */
export function updateEventAttachments(db: DB, eventId: number, attachments: CanonicalAttachment[]) {
	db.update(events)
		.set({ attachments })
		.where(eq(events.id, eventId))
		.run()
}

export interface EventWithId {
	event: PipelineEvent
	id: number
}

export function loadEventsWithId(db: DB, chatId: string, afterMs?: number): EventWithId[] {
	const cond = afterMs != null
		? and(eq(events.chatId, chatId), gte(events.receivedAtMs, afterMs))
		: eq(events.chatId, chatId)
	const rows = db.select().from(events).where(cond).orderBy(events.receivedAtMs, events.id).all()
	return rows.map(row => ({ event: reconstructEvent(row), id: row.id }))
}

/** Load attachments for a message from the latest message/edit event (used by download_file tool). */
export function loadMessageAttachments(db: DB, chatId: string, messageId: string): CanonicalAttachment[] | undefined {
	const row = db.select({ attachments: events.attachments })
		.from(events)
		.where(and(eq(events.chatId, chatId), eq(events.messageId, messageId)))
		.orderBy(desc(events.id))
		.limit(1)
		.get()
	return row?.attachments ?? undefined
}

// --- Background tasks storage ---

export type BackgroundTaskRow = typeof backgroundTasks.$inferSelect

export function insertBackgroundTask(db: DB, task: {
	intention?: string
	params: unknown
	sessionId: string
	startedMs: number
	timeoutMs: number
	typeName: string
}): number {
	const result = db.insert(backgroundTasks).values({
		intention: task.intention ?? null,
		lastUpdatedMs: task.startedMs,
		params: task.params,
		sessionId: task.sessionId,
		startedMs: task.startedMs,
		timeoutMs: task.timeoutMs,
		typeName: task.typeName,
	}).run()
	return Number(result.lastInsertRowid)
}

export function loadIncompleteBackgroundTasks(db: DB): BackgroundTaskRow[] {
	return db.select().from(backgroundTasks).where(eq(backgroundTasks.completed, false)).all()
}

export function updateBackgroundTaskCheckpoint(db: DB, id: number, checkpoint: unknown, lastUpdatedMs: number) {
	db.update(backgroundTasks)
		.set({ checkpoint, lastUpdatedMs })
		.where(eq(backgroundTasks.id, id))
		.run()
}

export function markBackgroundTaskCompleted(db: DB, id: number, finalSummary: string, fullOutputPath: null | string) {
	db.update(backgroundTasks)
		.set({ completed: true, finalSummary, fullOutputPath, lastUpdatedMs: Date.now() })
		.where(eq(backgroundTasks.id, id))
		.run()
}

export function loadBackgroundTask(db: DB, id: number): BackgroundTaskRow | undefined {
	return db.select().from(backgroundTasks).where(eq(backgroundTasks.id, id)).get()
}

/** Load completed tasks for a session, newest first (for retention eviction). */
export function loadCompletedBackgroundTasks(db: DB, sessionId: string): BackgroundTaskRow[] {
	return db.select().from(backgroundTasks).where(and(eq(backgroundTasks.sessionId, sessionId), eq(backgroundTasks.completed, true))).orderBy(desc(backgroundTasks.id)).all()
}
