import { describe, expect, it, vi } from 'vitest'

import { codexResponsesApi } from './codex-responses'

function sseResponse(events: unknown[]): Response {
	const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
	return new Response(body, {
		headers: { 'Content-Type': 'text/event-stream' },
		status: 200,
	})
}

describe('codexResponsesApi', () => {
	it('aggregates response.completed SSE into output and usage', async () => {
		const fetchMock = vi.fn(async () => sseResponse([
			{ type: 'response.created' },
			{
				response: {
					output: [
						{
							content: [{ text: 'hello codex', type: 'output_text' }],
							role: 'assistant',
							type: 'message',
						},
						{
							arguments: '{"query":"test"}',
							call_id: 'call_1',
							name: 'web_search',
							status: 'completed',
							type: 'function_call',
						},
					],
					status: 'completed',
					usage: {
						input_tokens: 120,
						input_tokens_details: { cached_tokens: 40 },
						output_tokens: 15,
					},
				},
				type: 'response.completed',
			},
		]))
		vi.stubGlobal('fetch', fetchMock)

		const log = {
			log: vi.fn(),
			withContext: () => log,
			withFields: () => log,
		}

		const result = await codexResponsesApi({
			accountId: 'acct_test',
			baseURL: 'https://chatgpt.com/backend-api',
			input: [{ content: 'hi', role: 'user', type: 'message' }],
			instructions: 'sys',
			label: 'test',
			log: log as never,
			model: 'gpt-5.4-codex',
			sessionId: 'chat-1',
			token: 'test-token',
		})

		expect(fetchMock).toHaveBeenCalledOnce()
		const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
		const [url, init] = calls[0]!
		expect(url).toBe('https://chatgpt.com/backend-api/codex/responses')
		expect(init.method).toBe('POST')
		expect(init.headers).toMatchObject({
			'Authorization': 'Bearer test-token',
			'chatgpt-account-id': 'acct_test',
			'session_id': 'chat-1',
		})

		const body = JSON.parse(String(init.body))
		expect(body.stream).toBe(true)
		expect(body.store).toBe(false)
		expect(body.prompt_cache_key).toBe('chat-1')
		expect(body.include).toEqual(['reasoning.encrypted_content'])

		expect(result.status).toBe('completed')
		expect(result.output).toHaveLength(2)
		expect(result.usage).toEqual({
			cacheReadTokens: 40,
			cacheWriteTokens: 0,
			inputTokens: 120,
			outputTokens: 15,
		})
	})

	it('falls back to streamed output_item events when response.completed output is empty', async () => {
		const fetchMock = vi.fn(async () => sseResponse([
			{
				item: {
					arguments: '{"text":"hello from codex"}',
					call_id: 'call_1',
					name: 'send_message',
					status: 'completed',
					type: 'function_call',
				},
				output_index: 0,
				type: 'response.output_item.done',
			},
			{
				response: {
					output: [],
					status: 'completed',
					usage: {
						input_tokens: 100,
						output_tokens: 78,
					},
				},
				type: 'response.completed',
			},
		]))
		vi.stubGlobal('fetch', fetchMock)

		const log = {
			log: vi.fn(),
			withContext: () => log,
			withFields: () => log,
		}

		const result = await codexResponsesApi({
			accountId: 'acct_test',
			baseURL: 'https://chatgpt.com/backend-api',
			input: [{ content: 'hi', role: 'user', type: 'message' }],
			instructions: 'sys',
			label: 'test',
			log: log as never,
			model: 'gpt-5.5',
			token: 'test-token',
		})

		expect(result.output).toHaveLength(1)
		expect(result.output[0]).toMatchObject({
			name: 'send_message',
			type: 'function_call',
		})
		expect(result.usage.outputTokens).toBe(78)
	})

	it('throws friendly usage-limit errors', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(
			JSON.stringify({
				error: {
					code: 'usage_limit_reached',
					message: 'limit hit',
					plan_type: 'PLUS',
					resets_at: Math.floor(Date.now() / 1000) + 3600,
				},
			}),
			{ status: 429 },
		)))

		await expect(codexResponsesApi({
			accountId: 'acct_test',
			baseURL: 'https://chatgpt.com/backend-api',
			input: [],
			label: 'test',
			log: { log: vi.fn(), withContext: () => ({ log: vi.fn(), withContext: () => ({ log: vi.fn(), withFields: () => ({ log: vi.fn() }) }), withFields: () => ({ log: vi.fn() }) }), withFields: () => ({ log: vi.fn() }) } as never,
			model: 'gpt-5.4-codex',
			token: 'test-token',
		})).rejects.toThrow(/ChatGPT usage limit/i)
	})
})
