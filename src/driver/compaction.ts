import type { Logger } from '@guiiai/logg'

import type { RenderedContext } from '../rendering/types'
import type {
	ConversationEntry,
	InputMessage,
	OutputMessage,
} from '../unified-api/types'
import type { LlmCallConfig } from './call-llm'
import type { CompactionSessionMeta, TurnResponseV2 } from './types'

import { callLlm } from './call-llm'
import { composeContext } from './context'
import { renderCompactionSystemPrompt, renderCompactionUserInstruction } from './prompt'

export interface CompactionParams extends LlmCallConfig {
	chatId: string
	existingSummary?: string
	log: Logger
	maxImagesAllowed?: number
	newCursorMs: number
	oldCursorMs: number
	rcWindow: RenderedContext
	trsWindow: TurnResponseV2[]
}

const COMPACT_MAX_TOKENS = 200000
const MAX_RETRIES = 3

function extractAssistantText(entries: ConversationEntry[]): string {
	const parts: string[] = []
	for (const e of entries) {
		if (e.kind !== 'message' || e.role !== 'assistant')
			continue
		for (const p of (e as OutputMessage).parts) {
			if (p.kind === 'text') {
				parts.push(p.text)
			}
			else if (p.kind === 'textGroup') {
				for (const t of p.content) parts.push(t.text)
			}
		}
	}
	return parts.join('')
}

export async function runCompaction(params: CompactionParams): Promise<CompactionSessionMeta> {
	const [compactSystemPrompt, compactUserInstruction] = await Promise.all([
		renderCompactionSystemPrompt(),
		renderCompactionUserInstruction(),
	])

	const ctx = composeContext(
		params.rcWindow,
		params.trsWindow,
		COMPACT_MAX_TOKENS,
		params.model,
		params.existingSummary,
	)

	const entries: ConversationEntry[] = [
		...(ctx?.entries ?? []),
    { kind: 'message', parts: [{ kind: 'text', text: compactUserInstruction }], role: 'user' } satisfies InputMessage,
	]

	let summary = ''
	let inputTokens = 0
	let outputTokens = 0
	let cacheReadTokens = 0
	let cacheWriteTokens = 0

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const result = await callLlm(params, entries, compactSystemPrompt, undefined, {
			dumpId: `${params.chatId}.compact`,
			label: `compact:${params.chatId}`,
			log: params.log,
			maxImagesAllowed: params.maxImagesAllowed,
		})
		summary = extractAssistantText(result.entries)
		inputTokens = result.usage.inputTokens
		outputTokens = result.usage.outputTokens
		cacheReadTokens = result.usage.cacheReadTokens
		cacheWriteTokens = result.usage.cacheWriteTokens
		if (summary)
			break
		params.log.withFields({ attempt, chatId: params.chatId, maxRetries: MAX_RETRIES })
			.warn('Compaction LLM returned empty content, retrying')
	}

	if (!summary)
		throw new Error('compaction produced empty summary')

	return {
		cacheReadTokens,
		cacheWriteTokens,
		inputTokens,
		newCursorMs: params.newCursorMs,
		oldCursorMs: params.oldCursorMs,
		outputTokens,
		summary,
	}
}
