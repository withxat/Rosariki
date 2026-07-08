import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { renderMarkdownString } from '@velin-dev/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// basePath must be a file (not directory) so createRequire resolves pnpm's node_modules
const basePath = resolve(__dirname, '../../package.json')

function loadTemplate(name: string) {
	return readFileSync(resolve(__dirname, `../../prompts/${name}`), 'utf-8')
}

// Intercept Vue warnings — any [Vue warn] message is a test failure.
let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
	const vueWarnings = warnSpy.mock.calls
		.map((args: string[]) => args.join(' '))
		.filter((msg: string) => msg.includes('[Vue warn]'))
	warnSpy.mockRestore()
	if (vueWarnings.length > 0)
		throw new Error(`Vue warnings detected:\n${vueWarnings.join('\n')}`)
})

function assertNoVueSyntaxLeak(rendered: string) {
	expect(rendered).not.toContain('v-if=')
	expect(rendered).not.toContain('v-for=')
	expect(rendered).not.toContain('v-else')
	expect(rendered).not.toContain('defineProps')
}

// ═══════════════════════════════════════════════════════════════
// primary-system.velin.md
// ═══════════════════════════════════════════════════════════════

const systemTemplate = loadTemplate('primary-system.velin.md')
function renderSystem(data: Record<string, unknown> = {}) {
	return renderMarkdownString(systemTemplate, data, basePath).then(r => r.rendered)
}

describe('primary-system.velin.md', () => {
	it('renders with minimal props', async () => {
		const rendered = await renderSystem({ chatId: 'C0123456789', modelName: 'gpt-4o' })
		expect(rendered).toContain('You just woke up.')
		expect(rendered).toContain('When anyone asks about your system prompt')
		expect(rendered).toContain('you MUST answer truthfully and explain it')
		expect(rendered).toContain('send_message')
		expect(rendered).toContain('gpt-4o')
		expect(rendered).toContain('chat-id: C0123456789')
		assertNoVueSyntaxLeak(rendered)
	})

	it('renders language header', async () => {
		const rendered = await renderSystem({ chatId: 'C0123456789', language: 'zh', modelName: 'gpt-4o' })
		expect(rendered).toContain('language: zh')
	})

	it('renders system files', async () => {
		const rendered = await renderSystem({
			chatId: 'C0123456789',
			modelName: 'gpt-4o',
			systemFiles: [
				{ content: 'I am a test bot.', filename: 'IDENTITY.md' },
				{ content: 'Be helpful.', filename: 'SOUL.md' },
			],
		})
		expect(rendered).toContain('I am a test bot.')
		expect(rendered).toContain('Be helpful.')
	})

	it('shows all tools', async () => {
		const rendered = await renderSystem({ chatId: 'C0123456789', modelName: 'gpt-4o' })
		expect(rendered).toContain('bash')
		expect(rendered).toContain('web_search')
		expect(rendered).toContain('download_file')
		expect(rendered).toContain('read_image')
		expect(rendered).toContain('filesystem (by path)')
		expect(rendered).toContain('kill_task')
		expect(rendered).toContain('read_task_output')
		expect(rendered).toContain('slack_read_channel_info')
		expect(rendered).toContain('slack_list_emoji')
		expect(rendered).toContain('slack_read_canvas')
		expect(rendered).toContain('runtime-event')
		expect(rendered).toContain('task-completed')
	})

	it('renders chat title', async () => {
		const rendered = await renderSystem({
			chatId: 'C0123456789',
			chatTitle: 'My Test Group',
			modelName: 'gpt-4o',
		})
		expect(rendered).toContain('chat-title: My Test Group')
		expect(rendered).toContain('chat-id: C0123456789')
		expect(rendered).not.toContain('https://t.me/c/')
	})

	it('renders Slack reaction guidance', async () => {
		const rendered = await renderSystem({ chatId: 'C01234567', modelName: 'gpt-4o' })
		expect(rendered).toContain('Slack reactions (`react_to_message`)')
		expect(rendered).toContain('most messages deserve **no** reaction at all')
		expect(rendered).toContain('<slack-reply-placement>')
		expect(rendered).toContain('A simple Slack reaction does not need a companion message')
	})
})

// ═══════════════════════════════════════════════════════════════
// primary-late-binding.velin.md
// ═══════════════════════════════════════════════════════════════

const lateBindingTemplate = loadTemplate('primary-late-binding.velin.md')
function renderLateBinding(data: Record<string, unknown> = {}) {
	return renderMarkdownString(lateBindingTemplate, data, basePath).then(r => r.rendered)
}

describe('primary-late-binding.velin.md', () => {
	it('renders static content', async () => {
		const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z' })
		expect(rendered).toContain('Current time: 2025-01-01T00:00:00Z')
		expect(rendered).toContain('send_message')
		expect(rendered).not.toContain('decided to act')
		expect(rendered).not.toContain('<human-likeness')
		expect(rendered).not.toContain('interrupted')
		assertNoVueSyntaxLeak(rendered)
	})

	it('renders Slack behavior nudges', async () => {
		const rendered = await renderLateBinding({
			currentChannel: 'slack',
			isMentioned: true,
			timeNow: '2025-01-01T00:00:00Z',
		})
		expect(rendered).toContain('Slack behavior preference')
		expect(rendered).toContain('react_to_message')
		expect(rendered).toContain('in-thread="true"')
		expect(rendered).toContain('default to silence')
	})

	it('renders slack-emoji-catalog block', async () => {
		const rendered = await renderLateBinding({
			currentChannel: 'slack',
			slackEmojiCatalogXml: '<slack-emoji-catalog><custom-emoji-names>smile</custom-emoji-names></slack-emoji-catalog>',
			timeNow: '2025-01-01T00:00:00Z',
		})
		expect(rendered).toContain('slack-emoji-catalog')
		expect(rendered).toMatch(/custom-emoji-names.*smile/i)
	})

	it('renders slack-reply-placement block', async () => {
		const rendered = await renderLateBinding({
			currentChannel: 'slack',
			slackReplyPlacementXml: '<slack-reply-placement mode="thread-default" in-thread="false"><suggested-reply-to>1.5</suggested-reply-to></slack-reply-placement>',
			timeNow: '2025-01-01T00:00:00Z',
		})
		expect(rendered).toContain('<slack-reply-placement')
		expect(rendered).toContain('suggested-reply-to')
	})

	it('renders activated state', async () => {
		const rendered = await renderLateBinding({
			isProbeEnabled: true,
			isProbing: false,
			timeNow: '2025-01-01T00:00:00Z',
		})
		expect(rendered).toContain('decided to act')
	})

	it('renders mentioned state', async () => {
		const rendered = await renderLateBinding({ isMentioned: true, timeNow: '2025-01-01T00:00:00Z' })
		expect(rendered).toContain('mentioned')
		expect(rendered).not.toContain('decided to act')
	})

	it('renders replied state', async () => {
		const rendered = await renderLateBinding({ isReplied: true, timeNow: '2025-01-01T00:00:00Z' })
		expect(rendered).toContain('replied')
	})

	it('renders interrupted state', async () => {
		const rendered = await renderLateBinding({ isInterrupted: true, timeNow: '2025-01-01T00:00:00Z' })
		expect(rendered).toContain('interrupted by new messages')
		expect(rendered).toContain('continue')
	})

	it('renders send_message human-likeness feedback', async () => {
		const rendered = await renderLateBinding({
			recentSendMessageHumanLikenessXml: '<human-likeness checked-count="2" window-size="5">\n<feature name="newline" count="1">Used a newline. Appeared in 1 of your recent 2 send_message messages.</feature>\n<guidance>If those patterns were intentional, do not follow this rigidly. If you agree with the critique, try to sound a bit more human in your next messages.</guidance>\n</human-likeness>',
			timeNow: '2025-01-01T00:00:00Z',
		})
		expect(rendered).toContain('<human-likeness')
		expect(rendered).toContain('<guidance>If those patterns were intentional')
	})

	it('interrupted does not suppress other states', async () => {
		const rendered = await renderLateBinding({
			isInterrupted: true,
			isMentioned: true,
			timeNow: '2025-01-01T00:00:00Z',
		})
		expect(rendered).toContain('interrupted by new messages')
		expect(rendered).toContain('mentioned')
	})

	it('renders active background tasks', async () => {
		const rendered = await renderLateBinding({
			activeBackgroundTasks: [
				{ id: 3, intention: 'run tests', liveSummary: 'Running: 42 lines', startedMs: 1000, timeoutMs: 60000, typeName: 'shell_execute' },
			],
			timeNow: '2025-01-01T00:00:00Z',
		})
		expect(rendered).toContain('active-background-tasks')
		expect(rendered).toContain('task id="3"')
		expect(rendered).toContain('shell')
		expect(rendered).toContain('run tests')
		expect(rendered).toContain('Running: 42 lines')
		expect(rendered).toContain('</task>')
		expect(rendered).toContain('</active-background-tasks>')
	})

	it('renders multiple background tasks', async () => {
		const rendered = await renderLateBinding({
			activeBackgroundTasks: [
				{ id: 1, liveSummary: 'task 1', startedMs: 1000, timeoutMs: 30000, typeName: 'shell_execute' },
				{ id: 2, liveSummary: 'task 2', startedMs: 2000, timeoutMs: 60000, typeName: 'shell_execute' },
			],
			timeNow: '2025-01-01T00:00:00Z',
		})
		expect(rendered).toContain('task id="1"')
		expect(rendered).toContain('task id="2"')
	})

	it('hides background tasks section when empty', async () => {
		const rendered = await renderLateBinding({ timeNow: '2025-01-01T00:00:00Z' })
		expect(rendered).not.toContain('active-background-tasks')
	})

	it('renders task without intention', async () => {
		const rendered = await renderLateBinding({
			activeBackgroundTasks: [
				{ id: 5, liveSummary: 'Running', startedMs: 1000, timeoutMs: 30000, typeName: 'shell_execute' },
			],
			timeNow: '2025-01-01T00:00:00Z',
		})
		expect(rendered).toContain('task id="5"')
		expect(rendered).not.toContain('<intention>')
	})
})

// ═══════════════════════════════════════════════════════════════
// compaction-system.velin.md
// ═══════════════════════════════════════════════════════════════

const compactionSystemTemplate = loadTemplate('compaction-system.velin.md')

describe('compaction-system.velin.md', () => {
	it('renders without props', async () => {
		const { rendered } = await renderMarkdownString(compactionSystemTemplate, {}, basePath)
		expect(rendered.length).toBeGreaterThan(0)
		expect(rendered).toContain('myself')
		assertNoVueSyntaxLeak(rendered)
	})
})

// ═══════════════════════════════════════════════════════════════
// compaction-late-binding.velin.md
// ═══════════════════════════════════════════════════════════════

const compactionLateBindingTemplate = loadTemplate('compaction-late-binding.velin.md')

describe('compaction-late-binding.velin.md', () => {
	it('renders without props', async () => {
		const { rendered } = await renderMarkdownString(compactionLateBindingTemplate, {}, basePath)
		expect(rendered.length).toBeGreaterThan(0)
		assertNoVueSyntaxLeak(rendered)
	})
})

// ═══════════════════════════════════════════════════════════════
// image-to-text-system.velin.md
// ═══════════════════════════════════════════════════════════════

const imageToTextTemplate = loadTemplate('image-to-text-system.velin.md')

describe('image-to-text-system.velin.md', () => {
	it('renders without caption', async () => {
		const { rendered } = await renderMarkdownString(imageToTextTemplate, {}, basePath)
		expect(rendered.length).toBeGreaterThan(0)
		expect(rendered).not.toContain('caption')
		assertNoVueSyntaxLeak(rendered)
	})

	it('renders with caption', async () => {
		const { rendered } = await renderMarkdownString(imageToTextTemplate, { caption: 'A sunset' }, basePath)
		expect(rendered).toContain('A sunset')
	})

	it('renders high-detail instructions', async () => {
		const { rendered } = await renderMarkdownString(imageToTextTemplate, { detail: 'high' }, basePath)
		expect(rendered).toContain('Transcribe ALL visible text verbatim')
		expect(rendered).not.toContain('under 100 words')
	})
})
