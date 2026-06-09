import { describe, expect, it } from 'vitest'

import {
	catalogViewFromCache,
	parseSlackEmojiList,
	renderSlackEmojiCatalogXml,
} from './emoji-catalog'

describe('parseSlackEmojiList', () => {
	it('collects custom image emoji keys and alias pairs', () => {
		const parsed = parseSlackEmojiList({
			eyes: 'unicode-placeholder',
			parrot: 'party_parrot',
			party_parrot: 'https://example.com/parrot.gif',
		})
		expect(parsed.customNames).toEqual(['party_parrot'])
		expect(parsed.aliases).toEqual([
			{ aliasOf: 'unicode-placeholder', name: 'eyes' },
			{ aliasOf: 'party_parrot', name: 'parrot' },
		])
		expect(parsed.totalCustom).toBe(1)
	})
})

describe('renderSlackEmojiCatalogXml', () => {
	it('includes custom names and slack_list_emoji hint', () => {
		const xml = renderSlackEmojiCatalogXml({
			aliases: [],
			categories: [{ name: 'Smileys' }],
			customNames: ['blob_help'],
			totalCustom: 1,
			truncated: false,
		})
		expect(xml).toContain('<slack-emoji-catalog>')
		expect(xml).toContain('blob_help')
		expect(xml).toContain('slack_list_emoji')
		expect(xml).toContain('standard-emoji-categories')
	})

	it('surfaces load errors', () => {
		const xml = renderSlackEmojiCatalogXml(catalogViewFromCache({
			categories: [],
			data: {},
			fetchedAt: Date.now(),
			loadError: 'missing_scope',
		}))
		expect(xml).toContain('emoji:read')
		expect(xml).toContain('missing_scope')
	})
})
