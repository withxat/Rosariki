import { describe, expect, it } from 'vitest'

import { createEmptyIC, reduce } from '../projection'
import { rcToXml, render } from '../rendering'
import { buildScheduleTriggeredRuntimeEvent } from '../runtime-event'

describe('schedule_triggered runtime event', () => {
	it('reduces and renders with instruction for model-authored send', () => {
		const event = buildScheduleTriggeredRuntimeEvent({
			chatId: 'C1',
			instruction: '提醒群友该点外卖了，语气轻松',
			receivedAtMs: 5_000,
			scheduleId: 3,
			scheduleName: '午餐提醒',
			utcOffsetMin: 480,
		})

		const ic = reduce(createEmptyIC('C1'), event)
		const rc = render(ic)
		expect(rc).toHaveLength(1)
		expect(rc[0]!.isRuntimeEvent).toBe(true)
		expect(rc[0]!.isScheduleTriggered).toBe(true)

		const xml = rcToXml(rc)
		expect(xml).toContain('type="schedule-triggered"')
		expect(xml).toContain('schedule-id="3"')
		expect(xml).toContain('name="午餐提醒"')
		expect(xml).toContain('提醒群友该点外卖了，语气轻松')
		expect(xml).toContain('call send_message')
	})
})
