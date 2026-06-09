import type { Logger } from '@guiiai/logg'

import type { ChatCompletionsEntry } from '../unified-api/chat-types'
import type { MigrationFunctionCallOutput, MigrationToolMessage } from '../unified-api/migrations'
import type { ResponsesDataItem } from '../unified-api/responses-types'
import type { ConversationEntry } from '../unified-api/types'
import type { DB } from './client'

import { sql } from 'drizzle-orm'

import {
	migrateChatEntries,
	migrateResponsesEntries,

} from '../unified-api/migrations'
import { codec } from './codec'
import { probeResponses, probeResponsesV2, turnResponses, turnResponsesV2 } from './schema'

function migrateRowEntries(provider: string, data: unknown): ConversationEntry[] {
	if (!Array.isArray(data))
		throw new Error(`v1 row has non-array data (provider=${provider})`)
	if (provider === 'openai-chat')
		return migrateChatEntries(data as (ChatCompletionsEntry | MigrationToolMessage)[])
	if (provider === 'responses')
		return migrateResponsesEntries(data as (MigrationFunctionCallOutput | ResponsesDataItem)[])
	throw new Error(`Unknown provider in v1 row: ${provider}`)
}

/**
 * One-shot backfill of turn_responses/probe_responses → v2 tables.
 * Runs inside a single transaction; any failure rolls back and rethrows.
 * Skipped if v2 tables already contain rows.
 */
export async function migrateV1ToV2(db: DB, logger: Logger): Promise<void> {
	const log = logger.withContext('migrate-v2')

	const v2TurnCount = db.select({ c: sql<number>`count(*)` }).from(turnResponsesV2).get()?.c ?? 0
	const v2ProbeCount = db.select({ c: sql<number>`count(*)` }).from(probeResponsesV2).get()?.c ?? 0
	if (v2TurnCount > 0 || v2ProbeCount > 0) {
		log.log('v2 tables already populated — skipping backfill')
		return
	}

	const v1Turns = db.select().from(turnResponses).all()
	const v1Probes = db.select().from(probeResponses).all()
	if (v1Turns.length === 0 && v1Probes.length === 0) {
		log.log('no v1 rows — skipping backfill')
		return
	}

	log.withFields({ probes: v1Probes.length, turns: v1Turns.length }).log('Backfilling v1 → v2')

	const turnInserts = await Promise.all(v1Turns.map(async row => ({
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		chatId: row.chatId,
		entries: await codec.stringify(migrateRowEntries(row.provider, row.data)),
		inputTokens: row.inputTokens,
		modelName: '',
		outputTokens: row.outputTokens,
		requestedAt: row.requestedAt,
	})))

	const probeInserts = await Promise.all(v1Probes.map(async row => ({
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		chatId: row.chatId,
		createdAt: row.createdAt,
		entries: await codec.stringify(migrateRowEntries(row.provider, row.data)),
		inputTokens: row.inputTokens,
		isActivated: row.isActivated,
		modelName: '',
		outputTokens: row.outputTokens,
		requestedAt: row.requestedAt,
	})))

	db.transaction((tx) => {
		for (const t of turnInserts) tx.insert(turnResponsesV2).values(t).run()
		for (const p of probeInserts) tx.insert(probeResponsesV2).values(p).run()
	})

	log.log('Backfill complete')
}
