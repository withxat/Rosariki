// OpenAI Chat Completions wire format — shape of outbound requests / inbound responses.

export interface ChatCompletionsToolCall {
	[key: string]: unknown
	function: { arguments: string, name: string }
	id: string
	type: 'function'
}

export interface ChatCompletionsContentPart {
	[key: string]: unknown
	text?: string
	type: string
}

export interface ChatCompletionsAssistantMessage {
	[key: string]: unknown
	content?: ChatCompletionsContentPart[] | null | string
	role: 'assistant'
	tool_calls?: ChatCompletionsToolCall[]
}

export interface ChatCompletionsToolMessage {
	[key: string]: unknown
	content: ChatCompletionsContentPart[] | string
	role: 'tool'
	tool_call_id: string
}

export type ChatCompletionsEntry = ChatCompletionsAssistantMessage | ChatCompletionsToolMessage

// --- Responses input content (used by Responses API and shared helpers) ---

export interface ResponsesInputText {
	text: string
	type: 'input_text' | 'output_text'
}

export interface ResponsesInputImage {
	detail: 'auto' | 'high' | 'low'
	image_url: string
	type: 'input_image'
}

export type ResponsesInputContent = ResponsesInputImage | ResponsesInputText
