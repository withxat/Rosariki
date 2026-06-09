import type { RenderedContext } from '../rendering/types'
import type { ConversationEntry, InputMessage, OutputMessage, ToolResult } from '../unified-api/types'

import { Buffer } from 'node:buffer'

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { mergeContext } from './merge'

function textSeg(ts: number, text: string): RenderedContext[number] {
	return {
		content: [{ text, type: 'text' }],
		receivedAtMs: ts,
	}
}

interface MiniTR {
	entries: ConversationEntry[]
	requestedAtMs: number
}
const tr = (ts: number, entries: ConversationEntry[]): MiniTR => ({ entries, requestedAtMs: ts })

function assistantText(text: string): OutputMessage {
	return {
		kind: 'message',
		parts: [{ kind: 'text', text }],
		reasoning: undefined,
		role: 'assistant',
	}
}

function assistantToolCall(callId: string, name: string, args: string): OutputMessage {
	return {
		kind: 'message',
		parts: [{ args, callId, kind: 'toolCall', name }],
		reasoning: undefined,
		role: 'assistant',
	}
}

function toolResult(callId: string, payload: string): ToolResult {
	return {
		callId,
		kind: 'toolResult',
		payload,
		requiresFollowUp: false,
	}
}

function userText(...texts: string[]): InputMessage {
	return {
		kind: 'message',
		parts: texts.map(t => ({ kind: 'text', text: t })),
		role: 'user',
	}
}

describe('mergeContext', () => {
	it('returns empty array for empty inputs', () => {
		expect(mergeContext([], [])).toEqual([])
	})

	it('merges consecutive RC segments into one user message', () => {
		const rc: RenderedContext = [textSeg(1000, 'hello'), textSeg(2000, 'world')]
		const result = mergeContext(rc, [])
		expect(result).toEqual([userText('hello', 'world')])
	})

	it('interleaves RC and TR by timestamp', () => {
		const rc: RenderedContext = [
			textSeg(1000, 'msg1'),
			textSeg(2000, 'msg2'),
			textSeg(4000, 'msg3'),
		]
		const trs = [tr(3000, [assistantText('reply1')])]

		const result = mergeContext(rc, trs)
		expect(result).toHaveLength(3)
		expect(result[0]).toEqual(userText('msg1', 'msg2'))
		expect(result[1]).toEqual(assistantText('reply1'))
		expect(result[2]).toEqual(userText('msg3'))
	})

	it('applies tiebreaker: RC before TR on equal timestamp', () => {
		const rc: RenderedContext = [textSeg(1000, 'simultaneous')]
		const trs = [tr(1000, [assistantText('reply')])]

		const result = mergeContext(rc, trs)
		expect(result).toEqual([userText('simultaneous'), assistantText('reply')])
	})

	it('handles tool call loop within a single TR', () => {
		const rc: RenderedContext = [textSeg(1000, 'original'), textSeg(2500, 'after tool')]
		const trs = [
			tr(1500, [
				assistantToolCall('tc1', 'send_message', '{"text":"hi"}'),
				toolResult('tc1', '{"ok":true}'),
				assistantText('done'),
			]),
		]

		const result = mergeContext(rc, trs)
		expect(result).toHaveLength(5)
		expect(result[0]).toEqual(userText('original'))
		expect(result[1]).toEqual(assistantToolCall('tc1', 'send_message', '{"text":"hi"}'))
		expect(result[2]).toEqual(toolResult('tc1', '{"ok":true}'))
		expect(result[3]).toEqual(assistantText('done'))
		expect(result[4]).toEqual(userText('after tool'))
	})

	it('handles image content pieces as ImagePart', () => {
		const img = sharp(Buffer.from([1, 2, 3]))
		const rc: RenderedContext = [{
			content: [
				{ text: 'photo:', type: 'text' },
				{ image: img, type: 'image' },
			],
			receivedAtMs: 1000,
		}]
		const result = mergeContext(rc, [])
		expect(result).toHaveLength(1)
		const msg = result[0] as InputMessage
		expect(msg.parts).toHaveLength(2)
		expect(msg.parts[0]).toEqual({ kind: 'text', text: 'photo:' })
		expect(msg.parts[1]).toEqual({ detail: 'low', image: img, kind: 'image' })
	})

	it('handles TR-only input (no RC)', () => {
		const result = mergeContext([], [tr(1000, [assistantText('hello')])])
		expect(result).toEqual([assistantText('hello')])
	})

	it('handles multiple consecutive TRs without RC between them', () => {
		const rc: RenderedContext = [textSeg(1000, 'start')]
		const trs = [
			tr(2000, [assistantText('first')]),
			tr(3000, [assistantText('second')]),
		]
		const result = mergeContext(rc, trs)
		expect(result).toEqual([
			userText('start'),
			assistantText('first'),
			assistantText('second'),
		])
	})

	it('preserves TR entry order within a single TR', () => {
		const rc: RenderedContext = [textSeg(1000, 'context')]
		const trs = [
			tr(2000, [
				assistantToolCall('tc1', 'send_message', '{}'),
				toolResult('tc1', 'ok'),
				assistantText('final'),
			]),
		]
		const result = mergeContext(rc, trs)
		expect(result).toEqual([
			userText('context'),
			assistantToolCall('tc1', 'send_message', '{}'),
			toolResult('tc1', 'ok'),
			assistantText('final'),
		])
	})
})
