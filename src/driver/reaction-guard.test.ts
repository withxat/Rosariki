import { describe, expect, it, vi } from 'vitest'

import { createReactionGuard } from './reaction-guard'

describe('createReactionGuard', () => {
	it('allows the first reaction to a sender', () => {
		const guard = createReactionGuard('chat1')
		expect(guard.checkAdd('user-a', '100.1')).toEqual({ allowed: true })
		guard.recordAdd('user-a', '100.1')
	})

	it('blocks a second reaction to another message from the same sender in the window', () => {
		const guard = createReactionGuard('chat1')
		guard.recordAdd('user-a', '100.1')

		const result = guard.checkAdd('user-a', '100.2')
		expect(result.allowed).toBe(false)
		expect(result.reason).toMatch(/Already reacted/)
	})

	it('allows reacting again to the same message id (idempotent retry)', () => {
		const guard = createReactionGuard('chat1')
		guard.recordAdd('user-a', '100.1')
		expect(guard.checkAdd('user-a', '100.1')).toEqual({ allowed: true })
	})

	it('allows reactions to different senders', () => {
		const guard = createReactionGuard('chat1')
		guard.recordAdd('user-a', '100.1')
		expect(guard.checkAdd('user-b', '101.1')).toEqual({ allowed: true })
	})

	it('expires reactions after the window', () => {
		vi.useFakeTimers()
		const guard = createReactionGuard('chat1', 60_000)
		guard.recordAdd('user-a', '100.1')

		vi.advanceTimersByTime(61_000)
		expect(guard.checkAdd('user-a', '100.2')).toEqual({ allowed: true })
		vi.useRealTimers()
	})
})
