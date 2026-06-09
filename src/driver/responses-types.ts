// OpenAI Responses API type definitions

// ── Request types ──

export interface ResponsesPayload {
	include?: string[]
	input: ResponseInputItem[] | string
	instructions: null | string
	max_output_tokens: null | number
	model: string
	parallel_tool_calls: boolean
	reasoning?: {
		effort: 'high' | 'low' | 'medium' | 'minimal' | 'none' | 'xhigh'
		summary: 'auto' | 'concise' | 'detailed'
	}
	store: boolean
	stream: boolean | null
	temperature: null | number
	tool_choice: ResponseToolChoice
	tools: null | ResponseTool[]
	top_p: null | number
}

export type ResponseInputItem
	= | ResponseFunctionCallOutputItem
		| ResponseFunctionToolCallItem
		| ResponseInputMessage
		| ResponseInputReasoning

export interface ResponseInputMessage {
	content: ResponseInputContent[] | string
	role: 'assistant' | 'developer' | 'system' | 'user'
	type: 'message'
}

export type ResponseInputContent
	= | ResponseInputImage
		| ResponseInputText

export interface ResponseInputText {
	text: string
	type: 'input_text' | 'output_text'
}

export interface ResponseInputImage {
	detail: 'auto' | 'high' | 'low'
	image_url: string
	type: 'input_image'
}

export interface ResponseInputReasoning {
	encrypted_content: string
	id: string
	summary: { text: string, type: 'summary_text' }[]
	type: 'reasoning'
}

export interface ResponseFunctionToolCallItem {
	arguments: string
	call_id: string
	name: string
	status: 'completed' | 'in_progress' | 'incomplete'
	type: 'function_call'
}

export interface ResponseFunctionCallOutputItem {
	call_id: string
	output: ResponseInputContent[] | string
	requiresFollowUp?: boolean
	status?: 'completed' | 'incomplete'
	type: 'function_call_output'
}

export interface ResponseTool {
	description?: string
	name: string
	parameters: Record<string, unknown>
	strict: boolean
	type: 'function'
}

export type ResponseToolChoice
	= | 'auto'
		| 'none'
		| 'required'
		| { name: string, type: 'function' }

// ── Response types ──

export interface ResponsesResult {
	error?: { code: string, message: string, type: string }
	id: string
	incomplete_details?: { reason: string }
	model: string
	object: string
	output: ResponseOutputItem[]
	output_text: string
	status: 'completed' | 'failed' | 'in_progress' | 'incomplete'
	usage?: {
		input_tokens: number
		input_tokens_details?: { cached_tokens: number }
		output_tokens: number
		output_tokens_details?: { reasoning_tokens: number }
		total_tokens: number
	}
}

export type ResponseOutputItem
	= | ResponseOutputFunctionCall
		| ResponseOutputMessage
		| ResponseOutputReasoning

export interface ResponseOutputMessage {
	content: ResponseOutputContentBlock[]
	role: 'assistant'
	type: 'message'
}

export type ResponseOutputContentBlock
	= | ResponseOutputRefusal
		| ResponseOutputText

export interface ResponseOutputText {
	text: string
	type: 'output_text'
}

export interface ResponseOutputRefusal {
	refusal: string
	type: 'refusal'
}

export interface ResponseOutputFunctionCall {
	arguments: string
	call_id: string
	name: string
	status: string
	type: 'function_call'
}

export interface ResponseOutputReasoning {
	encrypted_content?: string
	id: string
	summary: { text: string, type: 'summary_text' }[]
	type: 'reasoning'
}
