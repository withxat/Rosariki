import type { Logger } from '@guiiai/logg'
import type { WebClient } from '@slack/web-api'

const CACHE_TTL_MS = 5 * 60_000
const MAX_CUSTOM_NAMES_IN_PROMPT = 400

export interface SlackEmojiCache {
	categories: unknown[]
	data: Record<string, string>
	fetchedAt: number
	loadError?: string
}

export interface SlackEmojiAlias {
	aliasOf: string
	name: string
}

export interface SlackEmojiCatalogView {
	aliases: SlackEmojiAlias[]
	categories: unknown[]
	customNames: string[]
	loadError?: string
	totalCustom: number
	truncated: boolean
}

function escapeXml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function isImageUrl(value: string): boolean {
	return value.startsWith('http://') || value.startsWith('https://')
}

/** Shared emoji.list fetch — one cache for late-binding XML and slack_list_emoji. */
export async function loadSlackEmojiCache(client: WebClient, log: Logger, includeStandard = true, cached?: SlackEmojiCache): Promise<SlackEmojiCache> {
	const now = Date.now()
	if (cached && now - cached.fetchedAt < CACHE_TTL_MS)
		return cached

	try {
		const result = await client.emoji.list({ include_categories: includeStandard })
		const data: Record<string, string> = {}
		for (const [name, value] of Object.entries(result.emoji ?? {})) {
			if (typeof value === 'string')
				data[name] = value
		}
		return {
			categories: Array.isArray(result.categories) ? result.categories : [],
			data,
			fetchedAt: now,
		}
	}
	catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		log.withError(err).warn('emoji.list failed — emoji unavailable (needs emoji:read scope)')
		return { categories: [], data: {}, fetchedAt: now, loadError: message }
	}
}

/** Parse workspace custom emoji keys and alias pairs from emoji.list data. */
export function parseSlackEmojiList(emoji: Record<string, string> | undefined): Pick<SlackEmojiCatalogView, 'aliases' | 'customNames' | 'totalCustom'> {
	if (!emoji)
		return { aliases: [], customNames: [], totalCustom: 0 }

	const aliases: SlackEmojiAlias[] = []
	const customNames: string[] = []

	for (const [name, value] of Object.entries(emoji)) {
		if (!name)
			continue
		if (!isImageUrl(value)) {
			aliases.push({ aliasOf: value, name })
			continue
		}
		customNames.push(name)
	}

	customNames.sort((a, b) => a.localeCompare(b))
	aliases.sort((a, b) => a.name.localeCompare(b.name))
	return { aliases, customNames, totalCustom: customNames.length }
}

export function catalogViewFromCache(cache: SlackEmojiCache): SlackEmojiCatalogView {
	const parsed = parseSlackEmojiList(cache.data)
	const truncated = parsed.customNames.length > MAX_CUSTOM_NAMES_IN_PROMPT
	return {
		aliases: parsed.aliases.slice(0, 100),
		categories: cache.categories,
		customNames: parsed.customNames.slice(0, MAX_CUSTOM_NAMES_IN_PROMPT),
		totalCustom: parsed.totalCustom,
		truncated,
		...(cache.loadError ? { loadError: cache.loadError } : {}),
	}
}

export function renderSlackEmojiCatalogXml(catalog: SlackEmojiCatalogView): string {
	const lines = [
		'<slack-emoji-catalog>',
		'<usage>',
		'react_to_message: use bare names without colons (e.g. eyes, thumbsup, party_parrot).',
		'send_message mrkdwn: use :name: for workspace custom emoji; Unicode emoji work as literal characters.',
		'message_reaction events in context use the same bare names.',
		'Use slack_list_emoji for full workspace lists, standard emoji categories, or search.',
		'</usage>',
	]

	if (catalog.loadError) {
		lines.push(`<custom-emoji-warning>emoji.list failed: ${escapeXml(catalog.loadError)}. Grant the bot emoji:read scope. Use slack_list_emoji after fixing scopes.</custom-emoji-warning>`)
	}
	else if (catalog.customNames.length === 0) {
		lines.push('<custom-emoji-names count="0">(none returned)</custom-emoji-names>')
	}
	else {
		const truncNote = catalog.truncated
			? ` showing ${catalog.customNames.length} of ${catalog.totalCustom}`
			: ''
		lines.push(
			`<custom-emoji-names count="${catalog.totalCustom}"${catalog.truncated ? ' truncated="true"' : ''}${truncNote}>`,
			escapeXml(catalog.customNames.join(', ')),
			'</custom-emoji-names>',
		)
	}

	if (catalog.aliases.length > 0) {
		const aliasLines = catalog.aliases.map(a => `${a.name}→${a.aliasOf}`).join(', ')
		lines.push(`<custom-emoji-aliases>${escapeXml(aliasLines)}</custom-emoji-aliases>`)
	}

	if (catalog.categories.length > 0) {
		lines.push(`<standard-emoji-categories count="${catalog.categories.length}">Slack standard emoji categories are included in emoji.list. Use slack_list_emoji with include_standard=true for the full categorized list.</standard-emoji-categories>`)
	}

	lines.push('</slack-emoji-catalog>')
	return lines.join('\n')
}
