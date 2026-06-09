import { describe, expect, it } from 'vitest'

import { isCnWorkday, localDateAndTime } from './calendar'

describe('calendar', () => {
	it('localDateAndTime returns Shanghai date and HH:MM', () => {
		const now = new Date('2026-02-14T02:30:00.000Z')
		const { localDate, time, weekday } = localDateAndTime(now, 'Asia/Shanghai')
		expect(localDate).toBe('2026-02-14')
		expect(time).toBe('10:30')
		expect(weekday).toBe(6)
	})

	it('isCnWorkday treats Spring Festival调休 Saturday as workday', () => {
		expect(isCnWorkday('2026-02-14')).toBe(true)
	})

	it('isCnWorkday treats Spring Festival Sunday as non-workday', () => {
		expect(isCnWorkday('2026-02-15')).toBe(false)
	})
})
