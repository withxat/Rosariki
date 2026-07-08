import type { ResolvedChatConfig } from '../config/config'
import type { ConversationEntry } from '../unified-api/types'

export type ProviderFormat = 'anthropic-messages' | 'openai-chat' | 'openai-codex-responses' | 'responses'

export interface TurnResponseV2 {
	cacheReadTokens: number
	cacheWriteTokens: number
	entries: ConversationEntry[]
	inputTokens: number
	modelName: string
	outputTokens: number
	requestedAtMs: number
}

export interface ProbeResponseV2 {
	cacheReadTokens: number
	cacheWriteTokens: number
	createdAt: number
	entries: ConversationEntry[]
	inputTokens: number
	isActivated: boolean
	modelName: string
	outputTokens: number
	requestedAtMs: number
}

export interface LlmEndpoint {
	apiBaseUrl: string
	apiFormat?: ProviderFormat
	apiKey: string
	authPath?: string
	forceToolCall?: boolean
	maxImagesAllowed?: number
	model: string
	timeoutSec?: number
}

export interface DriverConfig {
	chatIds: string[]
	resolveChatConfig: (chatId: string) => ResolvedChatConfig
}

export interface CompactionConfig {
	maxContextEstTokens: number
	model?: LlmEndpoint
	workingWindowEstTokens: number
}

export interface CompactionSessionMeta {
	cacheReadTokens: number
	cacheWriteTokens: number
	inputTokens: number
	newCursorMs: number
	oldCursorMs: number
	outputTokens: number
	summary: string
}

export type { ResolvedChatConfig } from '../config/config'
