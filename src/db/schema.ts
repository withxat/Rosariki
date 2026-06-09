import type { CanonicalAttachment, CanonicalForwardInfo, CanonicalUser, ContentNode, ServiceAction } from '../adaptation/types'
import type { RuntimeEventData } from '../runtime-event'
import type { Recurrence } from '../schedule/types'

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** Legacy Telegram `messages` table JSON shapes (historical rows only). */
export interface LegacyMessageEntity {
	[key: string]: unknown
	length: number
	offset: number
	type: string
}

export interface LegacyAttachment {
	[key: string]: unknown
	fileId?: string
	mimeType?: string
	type: string
}

export interface LegacyForwardInfo {
	[key: string]: unknown
	date?: number
	fromChatId?: string
	fromUserId?: string
}

type AnyMsg = Record<string, any>

export const users = sqliteTable('users', {
	firstName: text('first_name').notNull(),
	id: text('id').primaryKey(),
	isBot: integer('is_bot', { mode: 'boolean' }).notNull(),
	isPremium: integer('is_premium', { mode: 'boolean' }).notNull(),
	lastName: text('last_name'),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
	username: text('username'),
})

export const messages = sqliteTable('messages', {
	// Media attachments — JSON array
	attachments: text('attachments', { mode: 'json' }).$type<LegacyAttachment[]>(),
	// Composite natural key: (chatId, messageId)
	chatId: text('chat_id').notNull(),

	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	date: integer('date').notNull(),
	deletedAt: integer('deleted_at', { mode: 'timestamp' }),
	editDate: integer('edit_date'),

	// Formatted text entities (bold, links, mentions, etc.) — stored as JSON
	entities: text('entities', { mode: 'json' }).$type<LegacyMessageEntity[]>(),

	// Forward info — stored as JSON since the shape varies
	// (forwarded from user vs channel vs hidden, etc.)
	forwardInfo: text('forward_info', { mode: 'json' }).$type<LegacyForwardInfo>(),
	// Media group (multiple photos/videos sent as album)
	mediaGroupId: text('media_group_id'),

	messageId: integer('message_id').notNull(),

	// Reply & thread context
	replyToMessageId: integer('reply_to_message_id'),

	replyToTopId: integer('reply_to_top_id'),

	senderId: text('sender_id').references(() => users.id),

	text: text('text'),

	// Sent via inline bot
	viaBotId: text('via_bot_id'),
}, table => [
	uniqueIndex('messages_chat_message_idx').on(table.chatId, table.messageId),
])

export const events = sqliteTable('events', {
	attachments: text('attachments', { mode: 'json' }).$type<CanonicalAttachment[]>(),

	chatId: text('chat_id').notNull(),
	content: text('content', { mode: 'json' }).$type<ContentNode[]>(),
	forwardInfo: text('forward_info', { mode: 'json' }).$type<CanonicalForwardInfo>(),
	id: integer('id').primaryKey({ autoIncrement: true }),
	// Bot's own sent messages — marked at creation time, not derived from sender ID
	isSelfSent: integer('is_self_sent', { mode: 'boolean' }),

	// message/edit only (canonical string IDs)
	messageId: text('message_id'),
	// delete only (canonical string IDs)
	messageIds: text('message_ids', { mode: 'json' }).$type<string[]>(),
	receivedAtMs: integer('received_at').notNull(),

	// message only (canonical string ID)
	replyToMessageId: text('reply_to_message_id'),

	// Runtime event data — JSON for runtime-originated events
	runtimeData: text('runtime_data', { mode: 'json' }).$type<RuntimeEventData>(),
	// JSON fields
	sender: text('sender', { mode: 'json' }).$type<CanonicalUser>(),
	senderId: text('sender_id'),

	// Service event action — JSON discriminated union
	serviceAction: text('service_action', { mode: 'json' }).$type<ServiceAction>(),
	// Denormalized plain text for SQL search — derived from content at persist time
	text: text('text'),

	timestampSec: integer('timestamp').notNull(),

	type: text('type').notNull().$type<'delete' | 'edit' | 'message' | 'runtime' | 'service'>(),

	utcOffsetMin: integer('utc_offset_min').notNull().default(480),
}, table => [
	index('events_chat_id_idx').on(table.chatId),
])

export const turnResponses = sqliteTable('turn_responses', {
	chatId: text('chat_id').notNull(),
	data: text('data', { mode: 'json' }).notNull().$type<unknown[]>(),
	id: integer('id').primaryKey({ autoIncrement: true }),
	inputTokens: integer('input_tokens').notNull(),
	outputTokens: integer('output_tokens').notNull(),
	provider: text('provider').notNull(),
	reasoningSignatureCompat: text('reasoning_signature_compat').default(''),
	requestedAt: integer('requested_at').notNull(),
	sessionMeta: text('session_meta', { mode: 'json' }),
}, table => [
	index('turn_responses_chat_requested_idx').on(table.chatId, table.requestedAt),
])

export const turnResponsesV2 = sqliteTable('turn_responses_v2', {
	cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
	cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
	chatId: text('chat_id').notNull(),
	entries: text('entries').notNull(),
	id: integer('id').primaryKey({ autoIncrement: true }),
	// inputTokens / outputTokens are TOTALS as billed — for Anthropic this means
	// we add cache_creation_input_tokens + cache_read_input_tokens to the API's
	// input_tokens (which only counts uncached input). cacheRead/cacheWriteTokens
	// are the cache-hit / cache-write components inside inputTokens.
	inputTokens: integer('input_tokens').notNull(),
	modelName: text('model_name').notNull().default(''),
	outputTokens: integer('output_tokens').notNull(),
	requestedAt: integer('requested_at').notNull(),
}, table => [
	index('turn_responses_v2_chat_requested_idx').on(table.chatId, table.requestedAt),
])

export const probeResponsesV2 = sqliteTable('probe_responses_v2', {
	cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
	cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
	chatId: text('chat_id').notNull(),
	createdAt: integer('created_at').notNull(),
	entries: text('entries').notNull(),
	id: integer('id').primaryKey({ autoIncrement: true }),
	inputTokens: integer('input_tokens').notNull(),
	isActivated: integer('is_activated', { mode: 'boolean' }).notNull().default(false),
	modelName: text('model_name').notNull().default(''),
	outputTokens: integer('output_tokens').notNull(),
	requestedAt: integer('requested_at').notNull(),
}, table => [
	index('probe_responses_v2_chat_idx').on(table.chatId),
])

export const compactions = sqliteTable('compactions', {
	cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
	cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
	chatId: text('chat_id').notNull(),
	createdAt: integer('created_at').notNull(),
	id: integer('id').primaryKey({ autoIncrement: true }),
	inputTokens: integer('input_tokens').notNull().default(0),
	newCursorMs: integer('new_cursor_ms').notNull(),
	oldCursorMs: integer('old_cursor_ms').notNull(),
	outputTokens: integer('output_tokens').notNull().default(0),
	summary: text('summary').notNull(),
}, table => [
	index('compactions_chat_id_idx').on(table.chatId),
])

export const probeResponses = sqliteTable('probe_responses', {
	chatId: text('chat_id').notNull(),
	createdAt: integer('created_at').notNull(),
	data: text('data', { mode: 'json' }).notNull().$type<AnyMsg[]>(),
	id: integer('id').primaryKey({ autoIncrement: true }),
	inputTokens: integer('input_tokens').notNull(),
	isActivated: integer('is_activated', { mode: 'boolean' }).notNull().default(false),
	outputTokens: integer('output_tokens').notNull(),
	provider: text('provider').notNull(),
	reasoningSignatureCompat: text('reasoning_signature_compat').default(''),
	requestedAt: integer('requested_at').notNull(),
}, table => [
	index('probe_responses_chat_idx').on(table.chatId),
])

export const imageAltTexts = sqliteTable('image_alt_texts', {
	altText: text('alt_text').notNull(),
	altTextTokens: integer('alt_text_tokens').notNull(),
	createdAt: integer('created_at').notNull(),
	id: integer('id').primaryKey({ autoIncrement: true }),
	imageHash: text('image_hash').notNull(),
	stickerSetName: text('sticker_set_name'),
}, table => [
	uniqueIndex('image_alt_texts_hash_idx').on(table.imageHash),
])

export const scheduledTasks = sqliteTable('scheduled_tasks', {
	chatId: text('chat_id').notNull(),
	createdAtMs: integer('created_at_ms').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	id: integer('id').primaryKey({ autoIncrement: true }),
	instruction: text('instruction').notNull(),
	lastFiredLocalDate: text('last_fired_local_date'),
	name: text('name'),
	recurrence: text('recurrence', { mode: 'json' }).notNull().$type<Recurrence>(),
}, table => [
	index('scheduled_tasks_chat_id_idx').on(table.chatId),
])

export const backgroundTasks = sqliteTable('background_tasks', {
	checkpoint: text('checkpoint', { mode: 'json' }).$type<unknown>(),
	completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
	finalSummary: text('final_summary'),
	fullOutputPath: text('full_output_path'),
	id: integer('id').primaryKey({ autoIncrement: true }),
	intention: text('intention'),
	lastUpdatedMs: integer('last_updated_ms').notNull(),
	params: text('params', { mode: 'json' }).notNull().$type<unknown>(),
	sessionId: text('session_id').notNull(),
	startedMs: integer('started_ms').notNull(),
	timeoutMs: integer('timeout_ms').notNull(),
	typeName: text('type_name').notNull(),
}, table => [
	index('background_tasks_session_idx').on(table.sessionId),
	index('background_tasks_completed_idx').on(table.completed),
])
