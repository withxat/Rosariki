import { Buffer } from 'node:buffer'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDir = join(tmpdir(), 'cahciua-codex-auth-test')

function fakeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
	return `${header}.${body}.sig`
}

afterEach(() => {
	rmSync(tempDir, { force: true, recursive: true })
	vi.restoreAllMocks()
})

describe('resolveCodexAuthSession', () => {
	it('reads tokens from Codex CLI auth.json and extracts account id', async () => {
		mkdirSync(tempDir, { recursive: true })
		const authPath = join(tempDir, 'auth.json')
		const accessToken = fakeJwt({
			'exp': Math.floor(Date.now() / 1000) + 3600,
			'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
		})
		writeFileSync(authPath, JSON.stringify({
			tokens: {
				access_token: accessToken,
				refresh_token: 'refresh-token',
			},
		}))

		const { resolveCodexAuthSession } = await import('./openai-codex')
		const session = await resolveCodexAuthSession(authPath)

		expect(session.accessToken).toBe(accessToken)
		expect(session.accountId).toBe('acct_123')
		expect(session.authPath).toBe(authPath)
	})

	it('fails clearly when auth.json is missing', async () => {
		const { resolveCodexAuthSession } = await import('./openai-codex')
		await expect(resolveCodexAuthSession(join(tempDir, 'missing.json'))).rejects.toThrow(/Codex auth not found/)
	})
})
