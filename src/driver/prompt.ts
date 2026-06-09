import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderMarkdownString } from '@velin-dev/core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const basePath = resolve(__dirname, '../../package.json')

// Strip Vue SSR artifacts (fragment markers, v-if placeholders),
// restore newline placeholders from template computed properties,
// unescape Velin's markdown escaping, and normalize whitespace.
function cleanVelinOutput(raw: string): string {
	return raw
		.replace(/<!--\[-->/g, '')
		.replace(/<!--\]-->/g, '')
		.replace(/<!--v-if-->/g, '')
		.replace(/\u200B/g, '\n')
		.replace(/\\`/g, '`')
		.replace(/\\_/g, '_')
		.replace(/^[^\S\n]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

const systemPromptTemplate = readFileSync(resolve(__dirname, '../../prompts/primary-system.velin.md'), 'utf-8')
const lateBindingTemplate = readFileSync(resolve(__dirname, '../../prompts/primary-late-binding.velin.md'), 'utf-8')
const compactionSystemTemplate = readFileSync(resolve(__dirname, '../../prompts/compaction-system.velin.md'), 'utf-8')
const compactionUserTemplate = readFileSync(resolve(__dirname, '../../prompts/compaction-late-binding.velin.md'), 'utf-8')

export async function renderSystemPrompt(params: {
	chatId: string
	chatTitle?: string
	currentChannel?: string
	language?: string
	modelName: string
	systemFiles?: { content: string, filename: string }[]
}) {
	const { rendered } = await renderMarkdownString(systemPromptTemplate, params, basePath)
	return cleanVelinOutput(rendered)
}

export async function renderLateBindingPrompt(params: {
	activeBackgroundTasks?: { id: number, intention?: string, liveSummary: string, startedMs: number, timeoutMs: number, typeName: string }[]
	currentChannel?: string
	isInterrupted?: boolean
	isMentioned?: boolean
	isProbeEnabled?: boolean
	isProbing?: boolean
	isReplied?: boolean
	isScheduleTriggered?: boolean
	recentSendMessageHumanLikenessXml?: string
	slackEmojiCatalogXml?: string
	slackReplyPlacementXml?: string
	timeNow: string
}) {
	const { rendered } = await renderMarkdownString(lateBindingTemplate, params, basePath)
	return cleanVelinOutput(rendered)
}

export async function renderCompactionSystemPrompt() {
	const { rendered } = await renderMarkdownString(compactionSystemTemplate, {}, basePath)
	return cleanVelinOutput(rendered)
}

export async function renderCompactionUserInstruction() {
	const { rendered } = await renderMarkdownString(compactionUserTemplate, {}, basePath)
	return cleanVelinOutput(rendered)
}
