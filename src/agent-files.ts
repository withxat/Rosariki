import type { Logger } from '@guiiai/logg'

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface AgentSystemFile {
	content: string
	filename: string
}

/** Loaded into primary system prompt in this order (OpenClaw-style). */
export const AGENT_FILE_NAMES = ['IDENTITY.md', 'SOUL.md'] as const

export function loadAgentSystemFiles(dir: string, logger: Logger): AgentSystemFile[] {
	const log = logger.withContext('agent-files')
	const files: AgentSystemFile[] = []

	for (const filename of AGENT_FILE_NAMES) {
		const path = resolve(dir, filename)
		if (!existsSync(path))
			continue
		const raw = readFileSync(path, 'utf-8').trim()
		if (!raw) {
			log.withFields({ path }).log('Skipping empty agent file')
			continue
		}
		files.push({ content: raw, filename })
	}

	if (files.length > 0)
		log.withFields({ dir, files: files.map(f => f.filename) }).log('Loaded agent identity files')
	else
		log.withFields({ dir }).log('No IDENTITY.md or SOUL.md found')

	return files
}
