import type { MessagesAssistantContentBlock } from './anthropic-types'
import type { ConversationEntry, OutputPart, ReasoningPart } from './types'

import { pickExtra } from './shared'

const TEXT_CORE = new Set(['type', 'text'])
const TOOL_USE_CORE = new Set(['type', 'id', 'name', 'input'])
const THINKING_CORE = new Set(['type', 'thinking', 'signature'])
const REDACTED_THINKING_CORE = new Set(['type', 'data'])

/**
 * Runtime Messages response parser. Assistants produce text / tool_use /
 * thinking / redacted_thinking — never tool_result (which is user-side input).
 */
export function fromMessagesOutput(blocks: MessagesAssistantContentBlock[]): ConversationEntry[] {
	const parts = blocks.map(blockToPart)
	if (parts.length === 0)
		return []
	return [{ kind: 'message', parts, reasoning: undefined, role: 'assistant' }]
}

function blockToPart(block: MessagesAssistantContentBlock): OutputPart {
	if (block.type === 'text') {
		const part: OutputPart = { kind: 'text', text: block.text }
		const extra = pickExtra('anthropicMessages', block, TEXT_CORE)
		if (extra !== undefined)
			part.extra = extra
		return part
	}
	if (block.type === 'tool_use') {
		const part: OutputPart = {
			args: JSON.stringify(block.input),
			callId: block.id,
			kind: 'toolCall',
			name: block.name,
		}
		const extra = pickExtra('anthropicMessages', block, TOOL_USE_CORE)
		if (extra !== undefined)
			part.extra = extra
		return part
	}
	if (block.type === 'thinking') {
		const part: ReasoningPart = {
			data: {
				data: { signature: block.signature, thinking: block.thinking, type: 'thinking' },
				source: 'anthropicMessages',
			},
			kind: 'reasoning',
		}
		const extra = pickExtra('anthropicMessages', block, THINKING_CORE)
		if (extra !== undefined)
			part.extra = extra
		return part
	}
	if (block.type === 'redacted_thinking') {
		const part: ReasoningPart = {
			data: {
				data: { data: block.data, type: 'redacted_thinking' },
				source: 'anthropicMessages',
			},
			kind: 'reasoning',
		}
		const extra = pickExtra('anthropicMessages', block, REDACTED_THINKING_CORE)
		if (extra !== undefined)
			part.extra = extra
		return part
	}
	throw new Error(`Unknown Messages assistant content block type: ${(block as { type: string }).type}`)
}
