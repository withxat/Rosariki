import type { Logger } from '@guiiai/logg'

import type {
	ResponseOutputItem,
	ResponseTool,
} from './responses-types'

import { arch, platform, release } from 'node:os'

import { registerHttpSecret } from '../http'

export interface ThinkingConfig {
	effort?: string
}

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

export interface CodexResponsesApiParams {
	accountId: string
	authPath?: string
	baseURL: string
	forceToolCall?: boolean
	input: unknown[]
	instructions?: string
	label: string
	log: Logger
	model: string
	sessionId?: string
	thinking?: ThinkingConfig
	timeoutSec?: number
	token: string
	tools?: ResponseTool[]
}

export interface CodexResponsesApiResult {
	output: ResponseOutputItem[]
	status: string
	usage: {
		cacheReadTokens: number
		cacheWriteTokens: number
		inputTokens: number
		outputTokens: number
	}
}

interface CompletedResponsePayload {
	output?: ResponseOutputItem[]
	status?: string
	usage?: {
		input_tokens?: number
		input_tokens_details?: { cached_tokens?: number }
		output_tokens?: number
	}
}

function resolveCodexUrl(baseURL: string): string {
	const normalized = baseURL.replace(/\/+$/, '')
	if (normalized.endsWith('/codex/responses'))
		return normalized
	if (normalized.endsWith('/codex'))
		return `${normalized}/responses`
	return `${normalized}/codex/responses`
}

function mapThinkingEffort(effort: ThinkingConfig['effort']): string | undefined {
	if (!effort)
		return undefined
	return effort === 'max' ? 'xhigh' : effort
}

function buildHeaders(token: string, accountId: string, sessionId?: string): Record<string, string> {
	const headers: Record<string, string> = {
		'Accept': 'text/event-stream',
		'Authorization': `Bearer ${token}`,
		'chatgpt-account-id': accountId,
		'Content-Type': 'application/json',
		'OpenAI-Beta': 'responses=experimental',
		'originator': 'cahciua',
		'User-Agent': `cahciua (${platform()} ${release()}; ${arch()})`,
	}
	if (sessionId) {
		headers.session_id = sessionId
		headers['x-client-request-id'] = sessionId
	}
	return headers
}

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body)
		return

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done)
				break
			buffer += decoder.decode(value, { stream: true })

			let idx = buffer.indexOf('\n\n')
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx)
				buffer = buffer.slice(idx + 2)

				const dataLines = chunk
					.split('\n')
					.filter(line => line.startsWith('data:'))
					.map(line => line.slice(5).trim())
				if (dataLines.length > 0) {
					const data = dataLines.join('\n').trim()
					if (data && data !== '[DONE]') {
						try {
							yield JSON.parse(data) as Record<string, unknown>
						}
						catch {}
					}
				}
				idx = buffer.indexOf('\n\n')
			}
		}
	}
	finally {
		try {
			await reader.cancel()
		}
		catch {}
		try {
			reader.releaseLock()
		}
		catch {}
	}
}

function normalizeCompletedResponse(response: CompletedResponsePayload | undefined): CompletedResponsePayload {
	if (!response)
		throw new Error('Codex response.completed event missing response payload')
	return response
}

function parseFriendlyCodexError(status: number, body: string): string {
	try {
		const parsed = JSON.parse(body) as {
			error?: { code?: string, message?: string, plan_type?: string, resets_at?: number }
		}
		const err = parsed.error
		if (!err)
			return body

		const code = err.code ?? ''
		if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || status === 429) {
			const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : ''
			const mins = err.resets_at
				? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
				: undefined
			const when = mins !== undefined ? ` Try again in ~${mins} min.` : ''
			return `You have hit your ChatGPT usage limit${plan}.${when}`.trim()
		}
		return err.message ?? body
	}
	catch {
		return body
	}
}

export async function codexResponsesApi(params: CodexResponsesApiParams): Promise<CodexResponsesApiResult> {
	const { label, log, token } = params
	registerHttpSecret(token)

	const abortController = new AbortController()
	const timeout = params.timeoutSec
		? setTimeout(
				() => abortController.abort(new Error(`codex responses request timed out after ${params.timeoutSec}s`)),
				params.timeoutSec * 1000,
			)
		: undefined

	try {
		const reasoningEffort = mapThinkingEffort(params.thinking?.effort)
		const body = JSON.stringify({
			include: ['reasoning.encrypted_content'],
			input: params.input,
			instructions: params.instructions,
			model: params.model,
			parallel_tool_calls: true,
			prompt_cache_key: params.sessionId,
			reasoning: reasoningEffort
				? { effort: reasoningEffort, summary: 'auto' }
				: undefined,
			store: false,
			stream: true,
			text: { verbosity: 'low' },
			tool_choice: params.forceToolCall ? 'required' : 'auto',
			...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
		})

		const url = resolveCodexUrl(params.baseURL || DEFAULT_CODEX_BASE_URL)
		const res = await fetch(url, {
			body,
			headers: buildHeaders(token, params.accountId, params.sessionId),
			method: 'POST',
			signal: abortController.signal,
		})

		if (!res.ok) {
			const text = await res.text()
			throw new Error(`Codex Responses API ${res.status}: ${parseFriendlyCodexError(res.status, text)}`)
		}

		let completed: CompletedResponsePayload | undefined
		for await (const event of parseSSE(res)) {
			const type = typeof event.type === 'string' ? event.type : undefined
			if (!type)
				continue

			if (type === 'error') {
				const message = typeof event.message === 'string' ? event.message : JSON.stringify(event)
				throw new Error(`Codex error: ${message}`)
			}

			if (type === 'response.failed') {
				const response = event.response as undefined | { error?: { message?: string } }
				throw new Error(response?.error?.message ?? 'Codex response failed')
			}

			if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
				completed = normalizeCompletedResponse(event.response as CompletedResponsePayload | undefined)
				break
			}
		}

		const response = normalizeCompletedResponse(completed)
		const output = response.output ?? []

		for (const item of output) {
			if (item.type === 'message') {
				for (const block of item.content) {
					if (block.type === 'output_text')
						log.withFields({ label, text: block.text }).log('content')
				}
			}
			else if (item.type === 'function_call') {
				log.withFields({ label, tool: item.name }).log('tool call')
			}
		}

		return {
			output,
			status: response.status ?? 'completed',
			usage: {
				cacheReadTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
				cacheWriteTokens: 0,
				inputTokens: response.usage?.input_tokens ?? 0,
				outputTokens: response.usage?.output_tokens ?? 0,
			},
		}
	}
	finally {
		if (timeout)
			clearTimeout(timeout)
	}
}
