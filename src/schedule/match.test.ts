import type { ScheduledTaskRow } from '../db/scheduled-tasks'

import { describe, expect, it } from 'vitest'

import { buildMatchContext, shouldFireTask } from './match'

function baseRow(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
	return {
		chatId: 'C1',
		createdAtMs: 0,
		enabled: true,
		id: 1,
		instruction: 'test',
		lastFiredLocalDate: null,
		name: null,
		recurrence: { time: '10:30', timezone: 'Asia/Shanghai', type: 'cn_workday' },
		...overrides,
	}
}

describe('shouldFireTask', () => {
	it('fires cn_workday at matching time on调休 workday', () => {
		const now = new Date('2026-02-14T02:30:00.000Z')
		const ctx = buildMatchContext(now)
		const result = shouldFireTask(baseRow(), ctx)
		expect(result.fire).toBe(true)
		expect(result.localDate).toBe('2026-02-14')
		expect(result.disableAfterFire).toBe(false)
	})

	it('skips when already fired today', () => {
		const now = new Date('2026-02-14T02:30:00.000Z')
		const ctx = buildMatchContext(now)
		const result = shouldFireTask(baseRow({ lastFiredLocalDate: '2026-02-14' }), ctx)
		expect(result.fire).toBe(false)
		expect(result.skipReason).toBe('already_fired_today')
	})

	it('skips when time does not match', () => {
		const now = new Date('2026-02-14T03:30:00.000Z')
		const ctx = buildMatchContext(now)
		const result = shouldFireTask(baseRow(), ctx)
		expect(result.fire).toBe(false)
		expect(result.skipReason).toBe('time_mismatch')
	})

	it('fires once when past onceAtMs and never fired', () => {
		const onceAtMs = Date.parse('2026-06-09T08:00:00.000Z')
		const now = new Date(onceAtMs + 60_000)
		const ctx = buildMatchContext(now)
		const result = shouldFireTask(baseRow({
			recurrence: { onceAtMs, type: 'once' },
		}), ctx)
		expect(result.fire).toBe(true)
		expect(result.disableAfterFire).toBe(true)
	})
})
