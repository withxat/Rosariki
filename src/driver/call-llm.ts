import type { Logger } from '@guiiai/logg'

import type { ChatCompletionsAssistantMessage } from '../unified-api/chat-types'
import type { ResponsesAssistantItem } from '../unified-api/responses-types'
import type { ConversationEntry } from '../unified-api/types'
import type { ProviderFormat } from './types'

import { writeFileSync } from 'node:fs'

import { resolveCodexAuthSession } from '../auth/openai-codex'
import {
	fromChatCompletionsOutput,
	fromMessagesOutput,
	fromResponsesOutput,
	toChatCompletionsInput,
	toMessagesInput,
	toResponsesInput,
} from '../unified-api'
import { chatCompletions } from './chat'
import { codexResponsesApi } from './codex-responses'
import { DUMP_DIR } from './constants'
import { trimImages } from './context'
import { applyAnthropicCachePoints, messagesApi } from './messages'
import { responsesApi } from './responses'

export interface LlmCallConfig {
	apiBaseUrl: string
	apiFormat?: ProviderFormat
	apiKey: string
	authPath?: string
	forceToolCall?: boolean
	model: string
	timeoutSec?: number
}

export interface ToolSchema {
	description?: string
	name: string
	parameters: Record<string, unknown>
}

export interface LlmCallUsage {
	cacheReadTokens: number
	cacheWriteTokens: number
	inputTokens: number
	outputTokens: number
}

export interface LlmCallResult {
	entries: ConversationEntry[]
	usage: LlmCallUsage
}

function dump(dumpId: string | undefined, suffix: string, body: unknown) {
	if (dumpId)
		writeFileSync(`${DUMP_DIR}/${dumpId}.${suffix}.json`, JSON.stringify(body, null, 2))
}

function toResponsesToolSchema(t: ToolSchema) {
	return {
		name: t.name,
		parameters: t.parameters,
		strict: false,
		type: 'function' as const,
		...(t.description ? { description: t.description } : {}),
	}
}

function toAnthropicToolSchema(t: ToolSchema) {
	return {
		name: t.name,
		...(t.description ? { description: t.description } : {}),
		input_schema: t.parameters,
	}
}

function toChatToolSchema(t: ToolSchema) {
	return {
		function: {
			name: t.name,
			...(t.description ? { description: t.description } : {}),
			parameters: t.parameters,
		},
		type: 'function' as const,
	}
}

function optionalTools<T>(mapped: T[] | undefined): T[] | undefined {
	return mapped && mapped.length > 0 ? mapped : undefined
}

export async function callLlm(config: LlmCallConfig, entries: ConversationEntry[], system: string, tools?: ToolSchema[], options?: { dumpId?: string, label: string, log: Logger, maxImagesAllowed?: number }): Promise<LlmCallResult> {
	const apiFormat: ProviderFormat = config.apiFormat ?? 'openai-chat'
	const log = options?.log
	const label = options?.label ?? ''

	let prepared = entries
	if (options?.maxImagesAllowed != null)
		prepared = trimImages(prepared, options.maxImagesAllowed)

	if (apiFormat === 'responses') {
		const input = await toResponsesInput(prepared)
		const wireTools = optionalTools(tools?.map(toResponsesToolSchema))
		dump(options?.dumpId, 'request', { input, instructions: system, model: config.model, tools: wireTools })

		const response = await responsesApi({
			apiKey: config.apiKey,
			baseURL: config.apiBaseUrl,
			input,
			instructions: system,
			model: config.model,
			...(wireTools ? { tools: wireTools } : {}),
			label,
			log: log!,
			timeoutSec: config.timeoutSec,
		})
		dump(options?.dumpId, 'response', response)

		const assistantItems = (response.output as unknown as ResponsesAssistantItem[]).filter(item =>
			item.type === 'message' || item.type === 'function_call' || item.type === 'reasoning')
		return {
			entries: fromResponsesOutput(assistantItems),
			usage: response.usage,
		}
	}

	if (apiFormat === 'openai-codex-responses') {
		const input = await toResponsesInput(prepared)
		const wireTools = optionalTools(tools?.map(toResponsesToolSchema))
		const auth = await resolveCodexAuthSession(config.authPath)
		dump(options?.dumpId, 'request', { authPath: auth.authPath, input, instructions: system, model: config.model, tools: wireTools })

		const response = await codexResponsesApi({
			accountId: auth.accountId,
			authPath: auth.authPath,
			baseURL: config.apiBaseUrl,
			input,
			instructions: system,
			model: config.model,
			sessionId: options?.dumpId,
			...(wireTools ? { tools: wireTools } : {}),
			forceToolCall: config.forceToolCall,
			label,
			log: log!,
			thinking: config.thinking,
			timeoutSec: config.timeoutSec,
			token: auth.accessToken,
		})
		dump(options?.dumpId, 'response', response)

		const assistantItems = (response.output as unknown as ResponsesAssistantItem[]).filter(item =>
			item.type === 'message' || item.type === 'function_call' || item.type === 'reasoning')
		return {
			entries: fromResponsesOutput(assistantItems),
			usage: response.usage,
		}
	}

	if (apiFormat === 'anthropic-messages') {
		const { messages, system: sysFromEntries } = await toMessagesInput(prepared)
		const effectiveSystem = sysFromEntries ?? system
		const wireTools = optionalTools(tools?.map(toAnthropicToolSchema))
		const tagged = applyAnthropicCachePoints(effectiveSystem, messages)
		dump(options?.dumpId, 'request', { messages: tagged.messages, model: config.model, system: tagged.system, tools: wireTools })

		const response = await messagesApi({
			apiKey: config.apiKey,
			baseURL: config.apiBaseUrl,
			messages: tagged.messages,
			model: config.model,
			system: tagged.system,
			...(wireTools ? { tools: wireTools } : {}),
			label,
			log: log!,
			timeoutSec: config.timeoutSec,
		})
		dump(options?.dumpId, 'response', response)

		return {
			entries: fromMessagesOutput(response.content),
			usage: response.usage,
		}
	}

	// openai-chat (default)
	const chatMessages = await toChatCompletionsInput(prepared)
	const wireTools = optionalTools(tools?.map(toChatToolSchema))
	dump(options?.dumpId, 'request', { messages: chatMessages, model: config.model, system, tools: wireTools })

	const response = await chatCompletions({
		apiKey: config.apiKey,
		baseURL: config.apiBaseUrl,
		messages: chatMessages,
		model: config.model,
		system,
		...(wireTools ? { tools: wireTools } : {}),
		label,
		log: log!,
		timeoutSec: config.timeoutSec,
	})
	dump(options?.dumpId, 'response', response)

	const choice = response.choices[0]
	if (!choice)
		return { entries: [], usage: response.usage }

	return {
		entries: fromChatCompletionsOutput([choice.message as ChatCompletionsAssistantMessage]),
		usage: response.usage,
	}
}
