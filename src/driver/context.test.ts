import type { RenderedContext } from '../rendering/types'
import type { ConversationEntry, InputPart, ToolResult } from '../unified-api/types'
import type { TurnResponseV2 } from './types'

import { describe, expect, it } from 'vitest'

import { composeContext } from './context'

const CURRENT_MODEL = 'test-model'

function textSeg(ts: number, text: string): RenderedContext[number] {
	return {
		content: [{ text, type: 'text' }],
		receivedAtMs: ts,
	}
}

function tr(ts: number, entries: ConversationEntry[], modelName = CURRENT_MODEL): TurnResponseV2 {
	return {
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		entries,
		inputTokens: 0,
		modelName,
		outputTokens: 0,
		requestedAtMs: ts,
	}
}

function assistantText(text: string): ConversationEntry {
	return {
		kind: 'message',
		parts: [{ kind: 'text', text }],
		reasoning: undefined,
		role: 'assistant',
	}
}

function assistantToolCall(callId: string, name = 'read'): ConversationEntry {
	return {
		kind: 'message',
		parts: [{ args: '{}', callId, kind: 'toolCall', name }],
		reasoning: undefined,
		role: 'assistant',
	}
}

function toolResult(callId: string, payload: InputPart[] | string): ToolResult {
	return {
		callId,
		kind: 'toolResult',
		payload,
		requiresFollowUp: true,
	}
}

const longText = (label: string): string => `${label}:${'x'.repeat(1000)}`

function getToolResults(entries: ConversationEntry[]): ToolResult[] {
	return entries.filter((e): e is ToolResult => e.kind === 'toolResult')
}

describe('composeContext — trimToolResults', () => {
	it('keeps only the last 5 oversized tool results untrimmed', () => {
		const rc: RenderedContext = [textSeg(100, 'hi')]
		const contents = Array.from({ length: 7 }, (_, i) => longText(`r${i + 1}`))
		const trs = contents.map((c, i) =>
			tr(200 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, c)]))

		const result = composeContext(rc, trs, 100_000, CURRENT_MODEL)
		const tres = getToolResults(result!.entries)
		expect(tres).toHaveLength(7)
		expect(tres[0]!.payload).toMatch(/\[trimmed/)
		expect(tres[1]!.payload).toMatch(/\[trimmed/)
		for (let i = 2; i < 7; i++) expect(tres[i]!.payload).toBe(contents[i])
	})

	it('does nothing when there are exactly 5 oversized tool results', () => {
		const rc: RenderedContext = [textSeg(100, 'hi')]
		const contents = Array.from({ length: 5 }, (_, i) => longText(`r${i + 1}`))
		const trs = contents.map((c, i) =>
			tr(200 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, c)]))

		const result = composeContext(rc, trs, 100_000, CURRENT_MODEL)
		const tres = getToolResults(result!.entries)
		for (let i = 0; i < 5; i++) expect(tres[i]!.payload).toBe(contents[i])
	})

	it('trimmed content preserves head and tail', () => {
		const content = `HEAD${'x'.repeat(800)}TAIL`
		const rc: RenderedContext = [textSeg(100, 'hi')]
		const trs: TurnResponseV2[] = [
			tr(200, [assistantToolCall('tc0'), toolResult('tc0', content)]),
			...Array.from({ length: 5 }, (_, i) =>
				tr(300 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, longText(`r${i + 1}`))])),
		]

		const result = composeContext(rc, trs, 100_000, CURRENT_MODEL)
		const trimmed = getToolResults(result!.entries)[0]!.payload as string
		expect(trimmed).toContain('HEAD')
		expect(trimmed).toContain('TAIL')
		expect(trimmed).toContain('[trimmed')
	})

	it('preserves assistant entries when trimming older oversized tool results', () => {
		const rc: RenderedContext = [textSeg(100, 'hi')]
		const trs: TurnResponseV2[] = [
			tr(200, [
				assistantToolCall('tc0'),
				toolResult('tc0', longText('oldest')),
				assistantText('I read the file'),
			]),
			...Array.from({ length: 5 }, (_, i) =>
				tr(300 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, longText(`r${i + 1}`))])),
		]

		const result = composeContext(rc, trs, 100_000, CURRENT_MODEL)
		const entries = result!.entries
		const tres = getToolResults(entries)
		expect(tres[0]!.payload).toMatch(/\[trimmed/)
		const hasAssistantText = entries.some(e =>
			e.kind === 'message' && e.role === 'assistant'
			&& e.parts.some(p => p.kind === 'text' && p.text === 'I read the file'))
		expect(hasAssistantText).toBe(true)
	})
})

describe('composeContext — reasoning strip on model mismatch', () => {
	const reasoningEntry: ConversationEntry = {
		kind: 'message',
		parts: [
			{ data: { data: { signature: 'sig', thinking: 'hmm', type: 'thinking' }, source: 'anthropicMessages' }, kind: 'reasoning' },
			{ kind: 'text', text: 'answer' },
		],
		reasoning: undefined,
		role: 'assistant',
	}

	it('preserves reasoning when modelName matches current model', () => {
		const rc: RenderedContext = [textSeg(100, 'hi')]
		const trs = [tr(200, [reasoningEntry], CURRENT_MODEL)]

		const result = composeContext(rc, trs, 100_000, CURRENT_MODEL)
		const assistant = result!.entries.find(e => e.kind === 'message' && e.role === 'assistant')
		expect(assistant).toBeDefined()
		const hasReasoning = (assistant as { parts: { kind: string }[] }).parts.some(p => p.kind === 'reasoning')
		expect(hasReasoning).toBe(true)
	})

	it('strips reasoning when modelName differs from current model', () => {
		const rc: RenderedContext = [textSeg(100, 'hi')]
		const trs = [tr(200, [reasoningEntry], 'other-model')]

		const result = composeContext(rc, trs, 100_000, CURRENT_MODEL)
		const assistant = result!.entries.find(e => e.kind === 'message' && e.role === 'assistant')
		expect(assistant).toBeDefined()
		const hasReasoning = (assistant as { parts: { kind: string }[] }).parts.some(p => p.kind === 'reasoning')
		expect(hasReasoning).toBe(false)
	})
})

describe('composeContext — misc', () => {
	it('returns null when rc + trs + summary are all empty', () => {
		expect(composeContext([], [], 100_000, CURRENT_MODEL)).toBeNull()
	})

	it('prepends compact summary as first user message', () => {
		const result = composeContext([textSeg(100, 'hi')], [], 100_000, CURRENT_MODEL, 'earlier stuff')
		expect(result).not.toBeNull()
		const first = result!.entries[0]!
		expect(first.kind).toBe('message')
		expect(first.kind === 'message' && first.role === 'user').toBe(true)
		const firstText = first.kind === 'message' && first.role === 'user'
			&& first.parts[0]!.kind === 'text'
			? first.parts[0]!.text
			: ''
		expect(firstText).toContain('Conversation summary')
		expect(firstText).toContain('earlier stuff')
	})
})
