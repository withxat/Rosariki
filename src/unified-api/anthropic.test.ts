import type { MessagesAssistantContentBlock, MessagesToolResultBlock } from './anthropic-types'
import type { ConversationEntry, OutputMessage } from './types'

import { describe, expect, it } from 'vitest'

import { fromMessagesOutput } from './from-messages-output'
import { toMessagesInput } from './to-messages-input'

describe('fromMessagesOutput', () => {
	it('converts text blocks', () => {
		const result = fromMessagesOutput([{ text: 'Hello world', type: 'text' }])
		expect(result).toHaveLength(1)
		const msg = result[0] as OutputMessage
		expect(msg.kind).toBe('message')
		expect(msg.role).toBe('assistant')
		expect(msg.parts).toEqual([{ kind: 'text', text: 'Hello world' }])
	})

	it('converts thinking blocks to ReasoningPart', () => {
		const blocks: MessagesAssistantContentBlock[] = [
			{ signature: 'sig123', thinking: 'Let me think...', type: 'thinking' },
			{ text: 'The answer is 42', type: 'text' },
		]
		const msg = fromMessagesOutput(blocks)[0] as OutputMessage
		expect(msg.parts).toHaveLength(2)
		expect(msg.parts[0]).toEqual({
			data: {
				data: { signature: 'sig123', thinking: 'Let me think...', type: 'thinking' },
				source: 'anthropicMessages',
			},
			kind: 'reasoning',
		})
		expect(msg.parts[1]).toEqual({ kind: 'text', text: 'The answer is 42' })
	})

	it('converts redacted_thinking blocks', () => {
		const msg = fromMessagesOutput([
			{ data: 'opaque_data_here', type: 'redacted_thinking' },
			{ text: 'Result', type: 'text' },
		])[0] as OutputMessage
		expect(msg.parts[0]).toEqual({
			data: {
				data: { data: 'opaque_data_here', type: 'redacted_thinking' },
				source: 'anthropicMessages',
			},
			kind: 'reasoning',
		})
	})

	it('converts tool_use blocks', () => {
		const msg = fromMessagesOutput([
			{ id: 'tu_123', input: { city: 'Paris' }, name: 'get_weather', type: 'tool_use' },
		])[0] as OutputMessage
		expect(msg.parts).toEqual([{
			args: '{"city":"Paris"}',
			callId: 'tu_123',
			kind: 'toolCall',
			name: 'get_weather',
		}])
	})

	it('preserves extra fields on tool_use', () => {
		const msg = fromMessagesOutput([
			{ cache_control: { type: 'ephemeral' }, id: 'tu_1', input: {}, name: 'fn', type: 'tool_use' },
		])[0] as OutputMessage
		const seg = msg.parts[0] as { extra?: { fields: Record<string, unknown>, source: string } }
		expect(seg.extra).toEqual({
			fields: { cache_control: { type: 'ephemeral' } },
			source: 'anthropicMessages',
		})
	})
})

describe('toMessagesInput', () => {
	it('extracts system messages to top-level parameter', async () => {
		const entries: ConversationEntry[] = [
			{ kind: 'message', parts: [{ kind: 'text', text: 'You are helpful.' }], role: 'system' },
			{ kind: 'message', parts: [{ kind: 'text', text: 'Hi' }], role: 'user' },
		]
		const { messages, system } = await toMessagesInput(entries)
		expect(system).toBe('You are helpful.')
		expect(messages).toHaveLength(1)
		expect(messages[0]!.role).toBe('user')
	})

	it('merges consecutive tool results into user message', async () => {
		const entries: ConversationEntry[] = [
			{ kind: 'message', parts: [{ kind: 'text', text: 'Do stuff' }], role: 'user' },
			{
				kind: 'message',
				parts: [
					{ args: '{}', callId: 'tc1', kind: 'toolCall', name: 'fn1' },
					{ args: '{}', callId: 'tc2', kind: 'toolCall', name: 'fn2' },
				],
				reasoning: undefined,
				role: 'assistant',
			},
			{ callId: 'tc1', kind: 'toolResult', payload: 'result1', requiresFollowUp: true },
			{ callId: 'tc2', kind: 'toolResult', payload: 'result2', requiresFollowUp: false },
		]
		const { messages } = await toMessagesInput(entries)
		expect(messages).toHaveLength(3)
		expect(messages[0]!.role).toBe('user')
		expect(messages[1]!.role).toBe('assistant')
		const assistantContent = messages[1]!.content as MessagesAssistantContentBlock[]
		expect(assistantContent).toHaveLength(2)
		expect(assistantContent.every(b => b.type === 'tool_use')).toBe(true)
		expect(messages[2]!.role).toBe('user')
		const userContent = messages[2]!.content as MessagesToolResultBlock[]
		expect(userContent).toHaveLength(2)
		expect(userContent.every(b => b.type === 'tool_result')).toBe(true)
	})

	it('round-trips thinking blocks', async () => {
		const originalBlocks: MessagesAssistantContentBlock[] = [
			{ signature: 'abc123', thinking: 'Deep thought', type: 'thinking' },
			{ text: 'Answer', type: 'text' },
		]
		const unified = fromMessagesOutput(originalBlocks)
		const { messages } = await toMessagesInput(unified)
		const content = messages[0]!.content as MessagesAssistantContentBlock[]
		expect(content[0]).toEqual({ signature: 'abc123', thinking: 'Deep thought', type: 'thinking' })
		expect(content[1]).toEqual({ text: 'Answer', type: 'text' })
	})

	it('converts Chat message-level reasoning to thinking block', async () => {
		const entries: ConversationEntry[] = [
			{
				kind: 'message',
				parts: [{ kind: 'text', text: 'Answer' }],
				reasoning: { reasoning_content: 'I thought about it', reasoning_opaque: 'sig_xyz' },
				role: 'assistant',
			},
		]
		const { messages } = await toMessagesInput(entries)
		const content = messages[0]!.content as MessagesAssistantContentBlock[]
		expect(content).toHaveLength(2)
		expect(content[0]!.type).toBe('thinking')
		expect((content[0] as { thinking: string }).thinking).toBe('I thought about it')
		expect((content[0] as Record<string, unknown>).signature).toBe('sig_xyz')
		expect(content[1]).toEqual({ text: 'Answer', type: 'text' })
	})

	it('converts reasoning_opaque only to redacted_thinking block', async () => {
		const entries: ConversationEntry[] = [
			{
				kind: 'message',
				parts: [{ kind: 'text', text: 'Answer' }],
				reasoning: { reasoning_opaque: 'opaque_only' },
				role: 'assistant',
			},
		]
		const { messages } = await toMessagesInput(entries)
		const content = messages[0]!.content as MessagesAssistantContentBlock[]
		expect(content[0]).toEqual({ data: 'opaque_only', type: 'redacted_thinking' })
	})

	it('throws on non-text system parts', async () => {
		const entries: ConversationEntry[] = [
			{
				kind: 'message',
				parts: [{ kind: 'image' } as never],
				role: 'system',
			},
		]
		await expect(toMessagesInput(entries)).rejects.toThrow(/System message parts must be text/)
	})

	it('normalizes Responses-sourced opaque-only reasoning to redacted_thinking', async () => {
		const entries: ConversationEntry[] = [
			{
				kind: 'message',
				parts: [
					{
						data: {
							data: { encrypted_content: 'opaque_blob', id: 'rs_1', summary: [], type: 'reasoning' },
							source: 'openaiResponses',
						},
						kind: 'reasoning',
					},
				],
				reasoning: undefined,
				role: 'assistant',
			},
		]
		const { messages } = await toMessagesInput(entries)
		const content = messages[0]!.content as MessagesAssistantContentBlock[]
		expect(content[0]).toEqual({ data: 'opaque_blob', type: 'redacted_thinking' })
	})

	it('preserves extra on reasoning parts through round-trip', () => {
		const blocks: MessagesAssistantContentBlock[] = [
			{
				cache_control: { type: 'ephemeral' },
				signature: 'sig',
				thinking: 'hmm',
				type: 'thinking',
			} as MessagesAssistantContentBlock,
		]
		const msg = fromMessagesOutput(blocks)[0] as OutputMessage
		const seg = msg.parts[0] as { extra?: { fields: Record<string, unknown>, source: string } }
		expect(seg.extra).toEqual({
			fields: { cache_control: { type: 'ephemeral' } },
			source: 'anthropicMessages',
		})
	})
})

describe('toMessagesInput tool id sanitization', () => {
	it('rewrites disallowed characters and pairs tool_use with tool_result', async () => {
		const entries: ConversationEntry[] = [
			{
				kind: 'message',
				parts: [{ args: '{}', callId: 'send_message:103', kind: 'toolCall', name: 'send_message' }],
				reasoning: undefined,
				role: 'assistant',
			},
			{ callId: 'send_message:103', kind: 'toolResult', payload: '{"ok":true}', requiresFollowUp: false },
		]

		const { messages } = await toMessagesInput(entries)
		const assistant = messages.find(m => m.role === 'assistant')!
		const user = messages.find(m => m.role === 'user')!
		const toolUse = (assistant.content as MessagesAssistantContentBlock[]).find(b => b.type === 'tool_use') as { id: string }
		const toolRes = (user.content as MessagesToolResultBlock[]).find(b => b.type === 'tool_result')!
		expect(toolUse.id).toBe('send_message_103')
		expect(toolRes.tool_use_id).toBe('send_message_103')
	})

	it('deduplicates collisions after sanitization', async () => {
		const entries: ConversationEntry[] = [
			{
				kind: 'message',
				parts: [
					{ args: '{}', callId: 'a:b', kind: 'toolCall', name: 'f' },
					{ args: '{}', callId: 'a?b', kind: 'toolCall', name: 'f' },
				],
				reasoning: undefined,
				role: 'assistant',
			},
			{ callId: 'a:b', kind: 'toolResult', payload: 'one', requiresFollowUp: false },
			{ callId: 'a?b', kind: 'toolResult', payload: 'two', requiresFollowUp: false },
		]

		const { messages } = await toMessagesInput(entries)
		const assistant = messages.find(m => m.role === 'assistant')!
		const user = messages.find(m => m.role === 'user')!
		const toolUses = (assistant.content as MessagesAssistantContentBlock[]).filter(b => b.type === 'tool_use') as Array<{ id: string }>
		const toolRes = (user.content as MessagesToolResultBlock[]).filter(b => b.type === 'tool_result')
		expect(toolUses.map(tu => tu.id)).toEqual(['a_b', 'a_b_2'])
		expect(toolRes.map(tr => tr.tool_use_id)).toEqual(['a_b', 'a_b_2'])
	})

	it('leaves already-valid ids untouched', async () => {
		const entries: ConversationEntry[] = [
			{
				kind: 'message',
				parts: [{ args: '{}', callId: 'toolu_abc123', kind: 'toolCall', name: 'f' }],
				reasoning: undefined,
				role: 'assistant',
			},
			{ callId: 'toolu_abc123', kind: 'toolResult', payload: 'ok', requiresFollowUp: false },
		]

		const { messages } = await toMessagesInput(entries)
		const assistant = messages.find(m => m.role === 'assistant')!
		const toolUse = (assistant.content as MessagesAssistantContentBlock[]).find(b => b.type === 'tool_use') as { id: string }
		expect(toolUse.id).toBe('toolu_abc123')
	})
})
