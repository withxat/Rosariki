import type { RenderedContext } from '../rendering/types'

import { describe, expect, it } from 'vitest'

import { computeSlackReplyPlacement, renderSlackReplyPlacementXml } from './slack-reply-placement'

function seg(receivedAtMs: number, opts: {
	isMyself?: boolean
	mentionsMe?: boolean
	messageId: string
	repliesToMe?: boolean
	replyToMessageId?: string
}) {
	return {
		content: [{ text: '', type: 'text' as const }],
		messageId: opts.messageId,
		receivedAtMs,
		...(opts.replyToMessageId && { replyToMessageId: opts.replyToMessageId }),
		...(opts.mentionsMe && { mentionsMe: true }),
		...(opts.repliesToMe && { repliesToMe: true }),
		...(opts.isMyself && { isMyself: true }),
	}
}

describe('computeSlackReplyPlacement', () => {
	it('returns undefined when no new external message segments', () => {
		expect(computeSlackReplyPlacement([], 0)).toBeUndefined()
		expect(computeSlackReplyPlacement([
			seg(100, { isMyself: true, messageId: '1.0' }),
		], 50)).toBeUndefined()
	})

	it('thread-required when someone replied to the bot', () => {
		const rc: RenderedContext = [
			seg(200, { messageId: '200.1', repliesToMe: true, replyToMessageId: '200.0' }),
		]
		const p = computeSlackReplyPlacement(rc, 100)
		expect(p).toEqual({
			inThread: true,
			mode: 'thread-required',
			suggestedReplyTo: '200.0',
			threadRootMessageId: '200.0',
			triggeringMessageId: '200.1',
		})
	})

	it('thread-default for channel @mention without in-thread', () => {
		const rc: RenderedContext = [
			seg(200, { mentionsMe: true, messageId: '200.5' }),
		]
		const p = computeSlackReplyPlacement(rc, 100)
		expect(p).toMatchObject({
			inThread: false,
			mode: 'thread-default',
			suggestedReplyTo: '200.5',
			triggeringMessageId: '200.5',
		})
	})

	it('thread-required for @mention inside an existing thread', () => {
		const rc: RenderedContext = [
			seg(200, { mentionsMe: true, messageId: '200.2', replyToMessageId: '200.0' }),
		]
		const p = computeSlackReplyPlacement(rc, 100)
		expect(p?.mode).toBe('thread-required')
		expect(p?.suggestedReplyTo).toBe('200.0')
	})

	it('prefers latest reply-to-bot over older mention', () => {
		const rc: RenderedContext = [
			seg(150, { mentionsMe: true, messageId: '150.0' }),
			seg(200, { messageId: '200.1', repliesToMe: true }),
		]
		const p = computeSlackReplyPlacement(rc, 100)
		expect(p?.triggeringMessageId).toBe('200.1')
		expect(p?.mode).toBe('thread-required')
	})

	it('returns undefined for new messages without mention or reply', () => {
		const rc: RenderedContext = [
			seg(200, { messageId: '200.0' }),
		]
		expect(computeSlackReplyPlacement(rc, 100)).toBeUndefined()
	})
})

describe('renderSlackReplyPlacementXml', () => {
	it('renders required placement block', () => {
		const xml = renderSlackReplyPlacementXml({
			inThread: true,
			mode: 'thread-required',
			suggestedReplyTo: '1.001',
			threadRootMessageId: '1.001',
			triggeringMessageId: '1.002',
		})
		expect(xml).toContain('mode="thread-required"')
		expect(xml).toContain('<suggested-reply-to>1.001</suggested-reply-to>')
		expect(xml).toContain('MUST set reply_to')
	})
})
