import type { ResponsesInputContent } from './chat-types'
import type {
	ResponsesDataItem,
	ResponsesFunctionCallOutput,
	ResponsesOutputContentBlock,
	ResponsesOutputFunctionCall,
	ResponsesOutputMessage,
	ResponsesOutputReasoning,
} from './responses-types'
import type {
	ConversationEntry,
	InputMessage,
	MessageReasoning,
	OutputMessage,
	OutputPart,
	ReasoningPart,
	TextPart,
	ToolResult,
} from './types'

import { messageReasoningText } from './reasoning'
import { applyExtra, assertSystemTextOnly, inputPartToResponsesContent } from './shared'

interface ResponsesInputMessage {
	content: ResponsesInputContent[] | string
	role: 'system' | 'user'
	type: 'message'
}

type ResponsesInputItem = ResponsesDataItem | ResponsesInputMessage

/** Runtime request builder for OpenAI Responses. Handles all roles. */
export async function toResponsesInput(entries: ConversationEntry[]): Promise<ResponsesInputItem[]> {
	let crossIndex = 0
	const mkCrossId = (): string => `rs_cross_${crossIndex++}`
	const chunks = await Promise.all(entries.map((entry): Promise<ResponsesInputItem[]> =>
		entry.kind === 'toolResult'
			? toolResultToItem(entry).then(i => [i])
			: entry.role === 'assistant'
				? Promise.resolve(messageToItems(entry, mkCrossId))
				: inputMessageToItem(entry).then(i => [i])))
	return chunks.flat()
}

async function inputMessageToItem(msg: InputMessage): Promise<ResponsesInputMessage> {
	assertSystemTextOnly(msg)
	return msg.parts.length === 1 && msg.parts[0]!.kind === 'text'
		? { content: msg.parts[0]!.text, role: msg.role, type: 'message' }
		: { content: await Promise.all(msg.parts.map(inputPartToResponsesContent)), role: msg.role, type: 'message' }
}

function textPartToBlock(tp: TextPart): ResponsesOutputContentBlock {
	return tp.refusal === true
		? applyExtra(tp.extra, 'openaiResponses', { refusal: tp.text, type: 'refusal' as const })
		: applyExtra(tp.extra, 'openaiResponses', { text: tp.text, type: 'output_text' as const })
}

function reasoningToItem(part: ReasoningPart, mkCrossId: () => string): ResponsesOutputReasoning | undefined {
	const data = part.data
	const build = (core: ResponsesOutputReasoning): ResponsesOutputReasoning =>
		applyExtra(part.extra, 'openaiResponses', core)
	if (data.source === 'openaiResponses') {
		const { encrypted_content, id, summary } = data.data
		return build({ encrypted_content, id, summary, type: 'reasoning' })
	}
	if (data.data.type === 'redacted_thinking') {
		return build({
			encrypted_content: data.data.data,
			id: mkCrossId(),
			summary: [],
			type: 'reasoning',
		})
	}
	const { signature, thinking } = data.data
	return build({
		encrypted_content: signature,
		id: mkCrossId(),
		summary: thinking.length > 0 ? [{ text: thinking, type: 'summary_text' }] : [],
		type: 'reasoning',
	})
}

function messageReasoningToItem(r: MessageReasoning, mkCrossId: () => string): ResponsesOutputReasoning | undefined {
	const text = messageReasoningText(r)
	const opaque = typeof r.reasoning_opaque === 'string' ? r.reasoning_opaque : undefined
	if (text === undefined && opaque === undefined)
		return undefined
	return {
		encrypted_content: opaque,
		id: mkCrossId(),
		summary: text !== undefined ? [{ text, type: 'summary_text' }] : [],
		type: 'reasoning',
	}
}

function partToItems(part: OutputPart, msgExtra: OutputMessage['extra'], mkCrossId: () => string): ResponsesDataItem[] {
	if (part.kind === 'textGroup') {
		const item: ResponsesOutputMessage = applyExtra(part.extra, 'openaiResponses', {
			content: part.content.map(textPartToBlock),
			role: 'assistant',
			type: 'message' as const,
		})
		return [item]
	}
	if (part.kind === 'text') {
		const item: ResponsesOutputMessage = applyExtra(msgExtra, 'openaiResponses', {
			content: [textPartToBlock(part)],
			role: 'assistant',
			type: 'message' as const,
		})
		return [item]
	}
	if (part.kind === 'reasoning') {
		const item = reasoningToItem(part, mkCrossId)
		return item !== undefined ? [item] : []
	}
	if (part.kind === 'toolCall') {
		const item: ResponsesOutputFunctionCall = applyExtra(part.extra, 'openaiResponses', {
			arguments: part.args,
			call_id: part.callId,
			name: part.name,
			type: 'function_call' as const,
		})
		return [item]
	}
	throw new Error(`Unknown OutputPart kind: ${(part as { kind: string }).kind}`)
}

function messageToItems(msg: OutputMessage, mkCrossId: () => string): ResponsesDataItem[] {
	const items = msg.parts.flatMap(part => partToItems(part, msg.extra, mkCrossId))
	if (msg.reasoning !== undefined && !msg.parts.some(p => p.kind === 'reasoning')) {
		const reasoningItem = messageReasoningToItem(msg.reasoning, mkCrossId)
		if (reasoningItem !== undefined)
			items.unshift(reasoningItem)
	}
	return items
}

async function toolResultToItem(tr: ToolResult): Promise<ResponsesFunctionCallOutput> {
	const output: ResponsesInputContent[] | string
		= typeof tr.payload === 'string'
			? tr.payload
			: await Promise.all(tr.payload.map(inputPartToResponsesContent))
	return { call_id: tr.callId, output, type: 'function_call_output' }
}
