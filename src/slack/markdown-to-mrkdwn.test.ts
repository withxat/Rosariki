import { describe, expect, it } from 'vitest'

import { markdownToMrkdwn } from './markdown-to-mrkdwn'

describe('markdownToMrkdwn', () => {
	it('converts common Markdown inline formatting to Slack mrkdwn', () => {
		expect(markdownToMrkdwn('**bold** and *italic*')).toBe('​*bold*​ and ​_italic_​')
		expect(markdownToMrkdwn('[link](https://example.com)')).toBe('<https://example.com|link>')
		expect(markdownToMrkdwn('~~strike~~')).toBe('​~strike~​')
		expect(markdownToMrkdwn('`code`')).toBe('`code`')
	})

	it('maps ||spoiler|| to Slack italic mrkdwn', () => {
		expect(markdownToMrkdwn('||spoiler||')).toBe('​_spoiler_​')
		expect(markdownToMrkdwn('before ||hidden|| after')).toBe('before ​_hidden_​ after')
	})

	it('preserves Slack emoji shortcodes and empty input', () => {
		expect(markdownToMrkdwn(':smile: hi')).toBe(':smile: hi')
		expect(markdownToMrkdwn('')).toBe('')
	})
})
