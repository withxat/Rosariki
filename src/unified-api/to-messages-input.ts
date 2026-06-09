import type {
	MessagesAssistantContentBlock,
	MessagesImageBlock,
	MessagesMessage,
	MessagesTextBlock,
	MessagesToolResultBlock,
	MessagesToolUseBlock,
	MessagesUserContentBlock,
} from './anthropic-types'
import type {
	ConversationEntry,
	ImagePart,
	InputPart,
	MessageReasoning,
	OutputMessage,
	OutputPart,
	ReasoningPart,
	ToolResult,
} from './types'

import { flattenResponsesSummary, messageReasoningText } from './reasoning'
import { applyExtra, assertSystemTextOnly, sharpToEncoded } from './shared'

/** Runtime request builder for Anthropic Messages. `system` is top-level. */
export async function toMessagesInput(entries: ConversationEntry[]): Promise<{ messages: MessagesMessage[], system: string | undefined }> {
	const systemParts: string[] = []
	const messages: MessagesMessage[] = []
	const idRemap = buildToolIdRemap(entries)

	for (const entry of entries) {
		if (entry.kind === 'toolResult') {
			appendToUser(messages, [await toolResultToBlock(entry, idRemap)])
		}
		else if (entry.role === 'system') {
			assertSystemTextOnly(entry)
			for (const p of entry.parts) {
				if (p.kind === 'text')
					systemParts.push(p.text)
			}
		}
		else if (entry.role === 'user') {
			appendToUser(messages, await Promise.all(entry.parts.map(inputPartToUserBlock)))
		}
		else if (entry.role === 'assistant') {
			appendToAssistant(messages, await assistantMessageToBlocks(entry, idRemap))
		}
	}

	return {
		messages,
		system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
	}
}

// Anthropic tool_use.id / tool_result.tool_use_id must match /^[a-zA-Z0-9_-]+$/.
// Other providers (OpenAI) allow richer formats like `send_message:103` that
// round-trip through our IR. Walk entries once, collect every tool_use id,
// replace disallowed chars with '_', and dedupe collisions with a numeric
// suffix. Both sides (call + result) share the same remap so pairing holds.
function buildToolIdRemap(entries: ConversationEntry[]): Map<string, string> {
	const remap = new Map<string, string>()
	const used = new Set<string>()
	const assign = (id: string): void => {
		if (remap.has(id))
			return
		const base = id.replace(/[^\w-]/g, '_') || 'id'
		let candidate = base
		let n = 2
		while (used.has(candidate)) candidate = `${base}_${n++}`
		remap.set(id, candidate)
		used.add(candidate)
	}
	for (const entry of entries) {
		if (entry.kind === 'toolResult') {
			assign(entry.callId)
		}
		else if (entry.role === 'assistant') {
			for (const p of entry.parts) {
				if (p.kind === 'toolCall')
					assign(p.callId)
			}
		}
	}
	return remap
}

const remapId = (remap: Map<string, string>, id: string): string => remap.get(id) ?? id

async function assistantMessageToBlocks(msg: OutputMessage, idRemap: Map<string, string>): Promise<MessagesAssistantContentBlock[]> {
	const blocks = msg.parts.flatMap(p => partToAssistantBlocks(p, idRemap))

	if (msg.reasoning !== undefined && !msg.parts.some(p => p.kind === 'reasoning')) {
		const thinkingBlock = messageReasoningToThinkingBlock(msg.reasoning)
		if (thinkingBlock !== undefined)
			blocks.unshift(thinkingBlock)
	}

	return blocks
}

function parseToolArgs(raw: string): Record<string, unknown> {
	// Anthropic `input` must be an object; IR carries raw wire strings.
	// On invalid JSON or non-object shape we fall back to `{}` — not ideal,
	// but Anthropic's schema leaves no room to pass the raw string through.
	try {
		const parsed: unknown = JSON.parse(raw)
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
	}
	catch { /* fall through */ }
	return {}
}

function partToAssistantBlocks(part: OutputPart, idRemap: Map<string, string>): MessagesAssistantContentBlock[] {
	if (part.kind === 'text') {
		if (part.text.length === 0)
			return []
		const block: MessagesTextBlock = applyExtra(part.extra, 'anthropicMessages', {
			text: part.text,
			type: 'text' as const,
		})
		return [block]
	}
	if (part.kind === 'textGroup') {
		return part.content.flatMap((tp): MessagesTextBlock[] => {
			if (tp.text.length === 0)
				return []
			return [applyExtra(tp.extra, 'anthropicMessages', { text: tp.text, type: 'text' as const })]
		})
	}
	if (part.kind === 'toolCall') {
		const block: MessagesToolUseBlock = applyExtra(part.extra, 'anthropicMessages', {
			id: remapId(idRemap, part.callId),
			input: parseToolArgs(part.args),
			name: part.name,
			type: 'tool_use' as const,
		})
		return [block]
	}
	if (part.kind === 'reasoning') {
		const block = reasoningToBlock(part)
		return block !== undefined ? [block] : []
	}
	throw new Error(`Unknown OutputPart kind: ${(part as { kind: string }).kind}`)
}

function reasoningToBlock(part: ReasoningPart): MessagesAssistantContentBlock | undefined {
	const data = part.data
	const build = <T extends MessagesAssistantContentBlock>(core: T): MessagesAssistantContentBlock =>
		applyExtra(part.extra, 'anthropicMessages', core)
	if (data.source === 'openaiResponses') {
		const { encrypted_content, summary } = data.data
		const text = flattenResponsesSummary(summary)
		// Empty reasoning → drop (no wire concept in Anthropic). Match
		// to-chat-input.ts so cross-format conversion is symmetric.
		if (text.length === 0 && encrypted_content === undefined)
			return undefined
		// Normalize: empty text + opaque signature → redacted_thinking (Responses
		// rows with only encrypted_content round-trip as redacted elsewhere).
		if (text.length === 0 && encrypted_content !== undefined) {
			return build({ data: encrypted_content, type: 'redacted_thinking' })
		}
		return build({ signature: encrypted_content, thinking: text, type: 'thinking' })
	}
	if (data.data.type === 'thinking') {
		return build({ signature: data.data.signature, thinking: data.data.thinking, type: 'thinking' })
	}
	return build({ data: data.data.data, type: 'redacted_thinking' })
}

function messageReasoningToThinkingBlock(r: MessageReasoning): MessagesAssistantContentBlock | undefined {
	const text = messageReasoningText(r)
	const opaque = typeof r.reasoning_opaque === 'string' ? r.reasoning_opaque : undefined
	if (text !== undefined)
		return { signature: opaque, thinking: text, type: 'thinking' }
	if (opaque !== undefined)
		return { data: opaque, type: 'redacted_thinking' }
	return undefined
}

async function inputPartToUserBlock(part: InputPart): Promise<MessagesUserContentBlock> {
	return part.kind === 'text' ? { text: part.text, type: 'text' } : await imagePartToBlock(part)
}

async function toolResultToBlock(tr: ToolResult, idRemap: Map<string, string>): Promise<MessagesToolResultBlock> {
	const block: MessagesToolResultBlock = { tool_use_id: remapId(idRemap, tr.callId), type: 'tool_result' }
	if (typeof tr.payload === 'string') {
		block.content = tr.payload
	}
	else if (tr.payload.length > 0) {
		block.content = await Promise.all(tr.payload.map(async (part): Promise<MessagesImageBlock | MessagesTextBlock> =>
			part.kind === 'text' ? { text: part.text, type: 'text' } : await imagePartToBlock(part)))
	}
	return block
}

async function imagePartToBlock(part: ImagePart): Promise<MessagesImageBlock> {
	const { buf, format } = await sharpToEncoded(part)
	return {
		source: {
			data: buf.toString('base64'),
			media_type: `image/${format}`,
			type: 'base64',
		},
		type: 'image',
	}
}

function appendToUser(messages: MessagesMessage[], blocks: MessagesUserContentBlock[]): void {
	if (blocks.length === 0)
		return
	const last = messages[messages.length - 1]
	if (last?.role === 'user') {
		last.content = [...normalizeExisting(last.content), ...blocks]
	}
	else {
		messages.push({ content: blocks, role: 'user' })
	}
}

function appendToAssistant(messages: MessagesMessage[], blocks: MessagesAssistantContentBlock[]): void {
	if (blocks.length === 0)
		return
	const last = messages[messages.length - 1]
	if (last?.role === 'assistant') {
		last.content = [...normalizeExisting(last.content), ...blocks]
	}
	else {
		messages.push({ content: blocks, role: 'assistant' })
	}
}

function normalizeExisting<T extends MessagesAssistantContentBlock | MessagesUserContentBlock>(content: string | T[]): T[] {
	return Array.isArray(content) ? content : [{ text: content, type: 'text' } as T]
}
