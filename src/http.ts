import { Buffer } from 'node:buffer'

const secrets = new Set<string>()

export function registerHttpSecret(secret: string) {
	if (secret)
		secrets.add(secret)
}

function redact(text: string): string {
	let result = text
	for (const secret of secrets) {
		result = result.replaceAll(secret, '*'.repeat(secret.length))
	}
	return result
}

export class HttpError extends Error {
	constructor(public readonly status: number, url: string) {
		super(`HTTP ${status}: ${redact(url)}`)
		this.name = 'HttpError'
	}
}

export async function httpGetBuffer(url: string): Promise<Buffer> {
	const resp = await fetch(url)
	if (!resp.ok)
		throw new HttpError(resp.status, url)
	return Buffer.from(await resp.arrayBuffer())
}
