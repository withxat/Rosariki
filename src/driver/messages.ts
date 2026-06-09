import type { Logger } from '@guiiai/logg'

import type {
	MessagesAssistantContentBlock,
	MessagesMessage,
	MessagesResponse,
} from '../unified-api/anthropic-types'

interface AnthropicTool {
	description?: string
	input_schema: Record<string, unknown>
	name: string
}

// Anthropic prompt cache TTL. We pick 1h over 5min for both breakpoints:
// chat history is append-only and reused across many turns, so 1h's 2× write
// cost is amortized after ~7 reads, and a single 5min refresh (1.25 + 1.25 =
// 2.5×) already costs more than one 1h write that survives the gap.
const CACHE_1H = { ttl: '1h' as const, type: 'ephemeral' as const }

export interface AnthropicCacheTagged {
	messages: MessagesMessage[]
	system: undefined | { cache_control: typeof CACHE_1H, text: string, type: 'text' }[]
}

// Tag a cache breakpoint on `system` (covers system + tools) and on the last
// block of the second-to-last message. The last message holds late-binding
// (primary turns) or the compaction instruction — content that mutates every
// turn — so we exclude it from the cache prefix.
//
// We shallow-clone only what we mutate so the caller's input stays untouched.
export function applyAnthropicCachePoints(system: string | undefined, messages: MessagesMessage[]): AnthropicCacheTagged {
	const taggedSystem = system
		? [{ cache_control: CACHE_1H, text: system, type: 'text' as const }]
		: undefined

	if (messages.length < 2)
		return { messages, system: taggedSystem }

	const targetIdx = messages.length - 2
	const target = messages[targetIdx]!
	if (!Array.isArray(target.content) || target.content.length === 0)
		return { messages, system: taggedSystem }

	const newContent = [...target.content]
	const lastIdx = newContent.length - 1
	newContent[lastIdx] = { ...newContent[lastIdx]!, cache_control: CACHE_1H }

	const newMessages = [...messages]
	newMessages[targetIdx] = { ...target, content: newContent } as MessagesMessage
	return { messages: newMessages, system: taggedSystem }
}

export interface MessagesApiParams {
	apiKey: string
	baseURL: string
	label: string
	log: Logger
	maxTokens?: number
	messages: MessagesMessage[]
	model: string
	system?: { cache_control?: unknown, text: string, type: 'text' }[]
	timeoutSec?: number
	tools?: AnthropicTool[]
}

export interface MessagesApiResult {
	content: MessagesAssistantContentBlock[]
	stop_reason: MessagesResponse['stop_reason']
	usage: {
		cacheReadTokens: number
		cacheWriteTokens: number
		inputTokens: number
		outputTokens: number
	}
}

export async function messagesApi(params: MessagesApiParams): Promise<MessagesApiResult> {
	const { label, log } = params
	const abortController = new AbortController()
	const timeout = params.timeoutSec
		? setTimeout(() => abortController.abort(new Error(`messages request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
		: undefined

	try {
		const body = JSON.stringify({
			max_tokens: params.maxTokens ?? 8192,
			model: params.model,
			...(params.system ? { system: params.system } : {}),
			messages: params.messages,
			...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
		})

		const url = `${params.baseURL.replace(/\/$/, '')}/messages`
		const res = await fetch(url, {
			body,
			headers: {
				'anthropic-version': '2023-06-01',
				'Content-Type': 'application/json',
				'x-api-key': params.apiKey,
			},
			method: 'POST',
			signal: abortController.signal,
		})

		if (!res.ok) {
			const text = await res.text()
			throw new Error(`Messages API ${res.status}: ${text}`)
		}

		const json = await res.json() as MessagesResponse

		for (const block of json.content) {
			if (block.type === 'text')
				log.withFields({ label, text: block.text }).log('content')
			else if (block.type === 'thinking')
				log.withFields({ label, reasoning: block.thinking }).log('reasoning')
			else if (block.type === 'tool_use')
				log.withFields({ label, tool: block.name }).log('tool call')
		}

		if (json.usage.cache_creation_input_tokens || json.usage.cache_read_input_tokens) {
			log.withFields({
				cacheRead: json.usage.cache_read_input_tokens ?? 0,
				cacheWrite: json.usage.cache_creation_input_tokens ?? 0,
				input: json.usage.input_tokens,
				label,
			}).log('cache')
		}

		const cacheReadTokens = json.usage.cache_read_input_tokens ?? 0
		const cacheWriteTokens = json.usage.cache_creation_input_tokens ?? 0

		return {
			content: json.content,
			stop_reason: json.stop_reason,
			usage: {
				cacheReadTokens,
				cacheWriteTokens,
				// Anthropic's input_tokens is the uncached remainder. Add cache reads
				// and writes so inputTokens is the full billable input total —
				// matches OpenAI's prompt_tokens / Responses' input_tokens semantics.
				inputTokens: json.usage.input_tokens + cacheReadTokens + cacheWriteTokens,
				outputTokens: json.usage.output_tokens,
			},
		}
	}
	finally {
		if (timeout)
			clearTimeout(timeout)
	}
}
