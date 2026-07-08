import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

import { refreshOpenAICodexToken } from '@earendil-works/pi-ai/oauth'

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const REFRESH_BUFFER_MS = 5 * 60 * 1000

interface CodexAuthTokens {
	access_token: string
	account_id?: string
	id_token?: string
	refresh_token: string
}

interface CodexAuthFile {
	last_refresh?: string
	tokens?: CodexAuthTokens
}

export interface CodexAuthSession {
	accessToken: string
	accountId: string
	authPath: string
}

function defaultAuthPath(): string {
	const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
	return join(codexHome, 'auth.json')
}

function decodeJwtPayload(token: string): null | Record<string, unknown> {
	try {
		const parts = token.split('.')
		if (parts.length !== 3)
			return null
		return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as Record<string, unknown>
	}
	catch {
		return null
	}
}

function tokenExpiresAtMs(accessToken: string): number | undefined {
	const payload = decodeJwtPayload(accessToken)
	const exp = payload?.exp
	return typeof exp === 'number' ? exp * 1000 : undefined
}

function extractAccountId(accessToken: string, tokens?: CodexAuthTokens): string {
	if (tokens?.account_id)
		return tokens.account_id

	const payload = decodeJwtPayload(accessToken)
	const authClaim = payload?.[JWT_CLAIM_PATH]
	if (authClaim && typeof authClaim === 'object' && authClaim !== null) {
		const accountId = (authClaim as { chatgpt_account_id?: unknown }).chatgpt_account_id
		if (typeof accountId === 'string' && accountId.length > 0)
			return accountId
	}

	throw new Error('Failed to extract chatgpt account id from Codex auth token')
}

function readAuthFile(authPath: string): CodexAuthFile {
	let raw: string
	try {
		raw = readFileSync(authPath, 'utf-8')
	}
	catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ENOENT') {
			throw new Error(
				`Codex auth not found at ${authPath}. Install Codex CLI and run \`codex login\`, or set authPath / CODEX_HOME.`,
			)
		}
		throw err
	}

	const parsed = JSON.parse(raw) as CodexAuthFile
	if (!parsed.tokens?.access_token?.trim() || !parsed.tokens.refresh_token?.trim()) {
		throw new Error(
			`Codex auth at ${authPath} is missing OAuth tokens. Run \`codex login\` on this machine.`,
		)
	}
	return parsed
}

function writeAuthFile(authPath: string, file: CodexAuthFile) {
	mkdirSync(dirname(authPath), { recursive: true })
	writeFileSync(authPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

async function refreshIfNeeded(authPath: string, file: CodexAuthFile): Promise<CodexAuthFile> {
	const accessToken = file.tokens!.access_token
	const expiresAt = tokenExpiresAtMs(accessToken)
	if (expiresAt != null && Date.now() < expiresAt - REFRESH_BUFFER_MS)
		return file

	const refreshed = await refreshOpenAICodexToken(file.tokens!.refresh_token)
	const next: CodexAuthFile = {
		...file,
		last_refresh: new Date().toISOString(),
		tokens: {
			...file.tokens!,
			access_token: refreshed.access,
			refresh_token: refreshed.refresh,
		},
	}
	writeAuthFile(authPath, next)
	return next
}

export async function resolveCodexAuthSession(authPath?: string): Promise<CodexAuthSession> {
	const resolvedPath = authPath ?? defaultAuthPath()
	const refreshed = await refreshIfNeeded(resolvedPath, readAuthFile(resolvedPath))
	const tokens = refreshed.tokens!
	return {
		accessToken: tokens.access_token,
		accountId: extractAccountId(tokens.access_token, tokens),
		authPath: resolvedPath,
	}
}
