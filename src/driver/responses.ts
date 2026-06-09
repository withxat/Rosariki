import type { Logger } from '@guiiai/logg'

import type {
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponsesResult,
	ResponseTool,
} from './responses-types'

export interface ResponsesApiParams {
	apiKey: string
	baseURL: string
	input: unknown[]
	instructions?: string
	label: string
	log: Logger
	model: string
	timeoutSec?: number
	tools?: ResponseTool[]
}

export interface ResponsesApiResult {
	output: ResponseOutputItem[]
	status: string
	usage: {
		cacheReadTokens: number
		cacheWriteTokens: number
		inputTokens: number
		outputTokens: number
	}
}

export async function responsesApi(params: ResponsesApiParams): Promise<ResponsesApiResult> {
	const { label, log } = params
	const abortController = new AbortController()
	const timeout = params.timeoutSec
		? setTimeout(() => abortController.abort(new Error(`responses request timed out after ${params.timeoutSec}s`)), params.timeoutSec * 1000)
		: undefined

	try {
		const body = JSON.stringify({
			input: params.input,
			model: params.model,
			...(params.instructions ? { instructions: params.instructions } : {}),
			...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
		})

		const url = `${params.baseURL.replace(/\/$/, '')}/responses`
		const res = await fetch(url, {
			body,
			headers: {
				'Authorization': `Bearer ${params.apiKey}`,
				'Content-Type': 'application/json',
			},
			method: 'POST',
			signal: abortController.signal,
		})

		if (!res.ok) {
			const text = await res.text()
			throw new Error(`Responses API ${res.status}: ${text}`)
		}

		const json = await res.json() as ResponsesResult

		for (const item of json.output) {
			if (item.type === 'message') {
				const msg = item as ResponseOutputMessage
				for (const block of msg.content) {
					if (block.type === 'output_text')
						log.withFields({ label, text: block.text }).log('content')
				}
			}
			else if (item.type === 'function_call') {
				log.withFields({ label, tool: item.name }).log('tool call')
			}
		}

		return {
			output: json.output,
			status: json.status,
			usage: {
				cacheReadTokens: json.usage?.input_tokens_details?.cached_tokens ?? 0,
				cacheWriteTokens: 0,
				// Responses' input_tokens already includes cache hits; cached_tokens
				// is a breakdown, not an additional bucket. No separate write counter.
				inputTokens: json.usage?.input_tokens ?? 0,
				outputTokens: json.usage?.output_tokens ?? 0,
			},
		}
	}
	finally {
		if (timeout)
			clearTimeout(timeout)
	}
}
