import type { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import {
	createChatInteractionTools,
	createReadImageTool,
	createSlackListEmojiTool,
	createSlackReadChannelInfoTool,
	createSlackReadChannelMembersTool,
	createSlackReadUserProfileTool,
	createTool,
	executeToolCall,
} from './tools'

async function createTinyPng(): Promise<Buffer> {
	const { default: sharp } = await import('sharp')
	return await sharp({
		create: {
			background: { alpha: 0, b: 0, g: 0, r: 0 },
			channels: 4,
			height: 1,
			width: 1,
		},
	}).png().toBuffer()
}

describe('createReadImageTool', () => {
	it('resolves image-to-text description via attachment file_id', async () => {
		const tinyPng = await createTinyPng()
		const downloadAttachment = vi.fn(async () => tinyPng)
		const resolveImageToText = vi.fn(async () => 'tiny image')
		const readFile = vi.fn(async () => tinyPng)
		const tool = createReadImageTool({ downloadAttachment, readFile, resolveImageToText })

		expect(tool.function.description).toContain('filesystem')
		expect((tool.function.parameters as any).properties.path).toMatchObject({ type: 'string' })

		const result = await tool.execute({ file_id: '1:0' }, { toolCallId: 'tc1' })
		expect(downloadAttachment).toHaveBeenCalledWith('1:0')
		expect(resolveImageToText).toHaveBeenCalled()
		expect(result).toEqual({
			content: JSON.stringify({ description: 'tiny image', ok: true }),
			requiresFollowUp: true,
		})
	})

	it('rejects when both file_id and path are provided', async () => {
		const tool = createReadImageTool({
			downloadAttachment: async () => await createTinyPng(),
			readFile: async () => await createTinyPng(),
		})

		const result = await tool.execute({ file_id: '1:0', path: '/tmp/test.png' }, { toolCallId: 'tc1' })
		expect(result).toEqual({
			content: JSON.stringify({ error: 'Provide exactly one of file_id or path.' }),
			requiresFollowUp: true,
		})
	})

	it('reads image from filesystem path', async () => {
		const tinyPng = await createTinyPng()
		const readFile = vi.fn(async () => tinyPng)
		const tool = createReadImageTool({
			downloadAttachment: async () => { throw new Error('should not be called') },
			readFile,
		})

		const result = await tool.execute({ path: '/tmp/test.png' }, { toolCallId: 'tc1' })
		expect(readFile).toHaveBeenCalledWith('/tmp/test.png')
		expect(result).toMatchObject({
			content: [{ detail: 'low', kind: 'image' }],
			requiresFollowUp: true,
		})
	})
})

describe('createChatInteractionTools', () => {
	it('creates Slack interaction tools', async () => {
		const reactToMessage = vi.fn(async () => {})
		const updateMessage = vi.fn(async () => ({ messageId: '1710000000.123456' }))
		const deleteMessage = vi.fn(async () => {})
		const readThread = vi.fn(async () => [{ message_id: '1710000000.123456', text: 'hello' }])
		const tools = createChatInteractionTools({ deleteMessage, reactToMessage, readThread, updateMessage })

		await tools.find(t => t.function.name === 'react_to_message')!.execute({
			message_id: '1710000000.123456',
			operation: 'add',
			reaction: ':eyes:',
		}, { toolCallId: 'tc1' })
		expect(reactToMessage).toHaveBeenCalledWith('1710000000.123456', ':eyes:', 'add')

		const updateResult = await tools.find(t => t.function.name === 'update_message')!.execute({
			message_id: '1710000000.123456',
			text: 'edited',
		}, { toolCallId: 'tc2' })
		expect(updateMessage).toHaveBeenCalledWith('1710000000.123456', 'edited')
		expect(updateResult.content).toBe(JSON.stringify({ message_id: '1710000000.123456', ok: true }))

		await tools.find(t => t.function.name === 'delete_message')!.execute({
			message_id: '1710000000.123456',
		}, { toolCallId: 'tc3' })
		expect(deleteMessage).toHaveBeenCalledWith('1710000000.123456')

		const threadResult = await tools.find(t => t.function.name === 'read_thread')!.execute({
			limit: 10,
			message_id: '1710000000.123456',
		}, { toolCallId: 'tc4' })
		expect(readThread).toHaveBeenCalledWith('1710000000.123456', 10)
		expect(threadResult.content).toBe(JSON.stringify({ ok: true, replies: [{ message_id: '1710000000.123456', text: 'hello' }] }))
	})
})

describe('slack tools', () => {
	it('wraps Slack read helpers as tool results', async () => {
		const channelInfo = createSlackReadChannelInfoTool(async () => ({ id: 'C1', name: 'general' }))
		expect(await channelInfo.execute({}, { toolCallId: 'tc1' })).toEqual({
			content: JSON.stringify({ id: 'C1', name: 'general' }),
			requiresFollowUp: true,
		})

		const members = createSlackReadChannelMembersTool(async limit => ({ limit, members: ['U1'] }))
		expect(await members.execute({ limit: 1 }, { toolCallId: 'tc1' })).toEqual({
			content: JSON.stringify({ limit: 1, members: ['U1'] }),
			requiresFollowUp: true,
		})

		const profile = createSlackReadUserProfileTool(async userId => ({ userId }))
		expect(await profile.execute({ user_id: 'slack:U1' }, { toolCallId: 'tc1' })).toEqual({
			content: JSON.stringify({ userId: 'slack:U1' }),
			requiresFollowUp: true,
		})

		const emoji = createSlackListEmojiTool(async opts => opts)
		expect(await emoji.execute({ include_standard: true, include_urls: true, limit: 0, query: 'ship' }, { toolCallId: 'tc1' })).toEqual({
			content: JSON.stringify({ includeStandard: true, includeUrls: true, limit: 0, query: 'ship' }),
			requiresFollowUp: true,
		})
	})
})

describe('executeToolCall', () => {
	const log = { error: () => {}, log: () => {}, withError: () => log, withFields: () => log } as any

	const greetTool = createTool({
		execute: async (input) => {
			const { name } = input as { name: string }
			return { content: `hello ${name}`, requiresFollowUp: false }
		},
		name: 'greet',
		parameters: {
			properties: { name: { type: 'string' } },
			required: ['name'],
			type: 'object',
		},
	})

	it('returns error for unknown tool', async () => {
		const result = await executeToolCall('id1', 'nonexistent', '{}', [greetTool], log)
		const payload = JSON.parse(result.payload as string)
		expect(payload.error).toContain('Unknown tool: nonexistent')
	})

	it('returns error for invalid JSON args', async () => {
		const result = await executeToolCall('id1', 'greet', '{not json', [greetTool], log)
		const payload = JSON.parse(result.payload as string)
		expect(payload.error).toContain('Invalid JSON')
		expect(payload.error).toContain('{not json')
	})

	it('returns error when args fail schema validation', async () => {
		const result = await executeToolCall('id1', 'greet', '{"age": 5}', [greetTool], log)
		const payload = JSON.parse(result.payload as string)
		expect(payload.error).toContain('do not match schema')
		expect(payload.error).toContain('name')
	})

	it('executes successfully with valid args', async () => {
		const result = await executeToolCall('id1', 'greet', '{"name": "world"}', [greetTool], log)
		expect(result.payload).toBe('hello world')
		expect(result.requiresFollowUp).toBe(false)
	})

	it('returns error when tool.execute throws', async () => {
		const throwingTool = createTool({
			execute: async () => { throw new Error('boom') },
			name: 'greet',
			parameters: greetTool.function.parameters,
		})
		const result = await executeToolCall('id1', 'greet', '{"name": "x"}', [throwingTool], log)
		const payload = JSON.parse(result.payload as string)
		expect(payload.error).toContain('boom')
		expect(result.requiresFollowUp).toBe(true)
	})
})
