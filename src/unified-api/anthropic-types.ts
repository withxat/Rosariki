export interface MessagesTextBlock {
	[key: string]: unknown
	text: string
	type: 'text'
}

export interface MessagesImageBlock {
	[key: string]: unknown
	source: {
		data: string
		media_type: `image/${string}`
		type: 'base64'
	} | {
		type: 'url'
		url: string
	}
	type: 'image'
}

export interface MessagesToolUseBlock {
	[key: string]: unknown
	id: string
	input: Record<string, unknown>
	name: string
	type: 'tool_use'
}

export interface MessagesToolResultBlock {
	[key: string]: unknown
	content?: MessagesContentBlock[] | string
	is_error?: boolean
	tool_use_id: string
	type: 'tool_result'
}

export interface MessagesThinkingBlock {
	[key: string]: unknown
	signature?: string
	thinking: string
	type: 'thinking'
}

export interface MessagesRedactedThinkingBlock {
	[key: string]: unknown
	data: string
	type: 'redacted_thinking'
}

export type MessagesUserContentBlock
	= | MessagesImageBlock
		| MessagesTextBlock
		| MessagesToolResultBlock

export type MessagesAssistantContentBlock
	= | MessagesRedactedThinkingBlock
		| MessagesTextBlock
		| MessagesThinkingBlock
		| MessagesToolUseBlock

export type MessagesContentBlock
	= | MessagesAssistantContentBlock
		| MessagesUserContentBlock

export interface MessagesUserMessage {
	content: MessagesUserContentBlock[] | string
	role: 'user'
}

export interface MessagesAssistantMessage {
	content: MessagesAssistantContentBlock[] | string
	role: 'assistant'
}

export type MessagesMessage = MessagesAssistantMessage | MessagesUserMessage

export interface MessagesResponse {
	content: MessagesAssistantContentBlock[]
	id: string
	model: string
	role: 'assistant'
	stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
	stop_sequence: null | string
	type: 'message'
	usage: {
		cache_creation_input_tokens?: number
		cache_read_input_tokens?: number
		input_tokens: number
		output_tokens: number
	}
}
