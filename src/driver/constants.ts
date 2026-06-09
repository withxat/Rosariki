import { mkdirSync } from 'node:fs'

export const DUMP_DIR = '/tmp/cahciua'

let dumpDirReady = false
export function ensureDumpDir(): void {
	if (dumpDirReady)
		return
	mkdirSync(DUMP_DIR, { recursive: true })
	dumpDirReady = true
}
