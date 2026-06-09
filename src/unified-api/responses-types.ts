// OpenAI Responses API wire format — shape of outbound input items / inbound output items.

import type { ResponsesInputContent } from './chat-types'

export type { ResponsesInputContent } from './chat-types'

export interface ResponsesOutputText {
	[key: string]: unknown
	text: string
	type: 'output_text'
}

export interface ResponsesOutputRefusal {
	[key: string]: unknown
	refusal: string
	type: 'refusal'
}

export type ResponsesOutputContentBlock = ResponsesOutputRefusal | ResponsesOutputText

export interface ResponsesOutputMessage {
	[key: string]: unknown
	content: ResponsesOutputContentBlock[]
	role: string
	type: 'message'
}

export interface ResponsesOutputFunctionCall {
	[key: string]: unknown
	arguments: string
	call_id: string
	name: string
	type: 'function_call'
}

export interface ResponsesOutputReasoning {
	[key: string]: unknown
	encrypted_content?: string
	id: string
	summary: { text: string, type: 'summary_text' }[]
	type: 'reasoning'
}

export interface ResponsesFunctionCallOutput {
	[key: string]: unknown
	call_id: string
	output: ResponsesInputContent[] | string
	type: 'function_call_output'
}

export type ResponsesDataItem
	= | ResponsesFunctionCallOutput
		| ResponsesOutputFunctionCall
		| ResponsesOutputMessage
		| ResponsesOutputReasoning

/** Subset of `ResponsesDataItem` that an assistant can produce (excludes client-authored `function_call_output`). */
export type ResponsesAssistantItem
	= | ResponsesOutputFunctionCall
		| ResponsesOutputMessage
		| ResponsesOutputReasoning
