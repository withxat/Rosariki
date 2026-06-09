import type { MessagesMessage } from '../unified-api/anthropic-types'

import { describe, expect, it } from 'vitest'

import { applyAnthropicCachePoints } from './messages'

const CACHE_1H = { ttl: '1h', type: 'ephemeral' }

describe('applyAnthropicCachePoints', () => {
	it('wraps system into a text block with 1h cache_control', () => {
		const { system } = applyAnthropicCachePoints('You are helpful.', [])
		expect(system).toEqual([{ cache_control: CACHE_1H, text: 'You are helpful.', type: 'text' }])
	})

	it('omits system when input is undefined', () => {
		const { system } = applyAnthropicCachePoints(undefined, [])
		expect(system).toBeUndefined()
	})

	it('tags last block of second-to-last message and leaves last message untouched', () => {
		const messages: MessagesMessage[] = [
			{ content: [{ text: 'history', type: 'text' }], role: 'user' },
			{ content: [{ text: 'reply A', type: 'text' }, { text: 'reply B', type: 'text' }], role: 'assistant' },
			{ content: [{ text: 'late-binding (volatile)', type: 'text' }], role: 'user' },
		]
		const { messages: out } = applyAnthropicCachePoints('sys', messages)
		const second = out[1]!.content as Record<string, unknown>[]
		expect(second[0]).toEqual({ text: 'reply A', type: 'text' })
		expect(second[1]).toEqual({ cache_control: CACHE_1H, text: 'reply B', type: 'text' })
		const last = out[2]!.content as Record<string, unknown>[]
		expect(last[0]).toEqual({ text: 'late-binding (volatile)', type: 'text' })
		expect(last[0]).not.toHaveProperty('cache_control')
	})

	it('does not mutate caller input', () => {
		const targetBlock = { text: 'block', type: 'text' as const }
		const messages: MessagesMessage[] = [
			{ content: [targetBlock], role: 'user' },
			{ content: [{ text: 'last', type: 'text' }], role: 'assistant' },
		]
		applyAnthropicCachePoints('sys', messages)
		expect(targetBlock).toEqual({ text: 'block', type: 'text' })
		expect(messages[0]!.content).toEqual([{ text: 'block', type: 'text' }])
		expect(messages[0]!.content === targetBlock as unknown).toBe(false)
	})

	it('skips message tagging when only one message is present', () => {
		const messages: MessagesMessage[] = [
			{ content: [{ text: 'lonely', type: 'text' }], role: 'user' },
		]
		const { messages: out } = applyAnthropicCachePoints('sys', messages)
		const block = (out[0]!.content as Record<string, unknown>[])[0]!
		expect(block).not.toHaveProperty('cache_control')
	})

	it('skips message tagging when target message has empty content array', () => {
		const messages: MessagesMessage[] = [
			{ content: [], role: 'user' },
			{ content: [{ text: 'last', type: 'text' }], role: 'assistant' },
		]
		const { messages: out } = applyAnthropicCachePoints('sys', messages)
		expect(out[0]!.content).toEqual([])
	})

	it('skips message tagging when target message has string content', () => {
		const messages: MessagesMessage[] = [
			{ content: 'plain string', role: 'user' },
			{ content: [{ text: 'last', type: 'text' }], role: 'assistant' },
		]
		const { messages: out } = applyAnthropicCachePoints('sys', messages)
		expect(out[0]!.content).toBe('plain string')
	})
})
