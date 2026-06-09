import type { ScheduledTaskRow } from '../db/scheduled-tasks'

import { isCnWorkday, localDateAndTime } from './calendar'
import { DEFAULT_TIMEZONE } from './types'

export interface MatchContext {
	localDate: string
	now: Date
	time: string
	weekday: number
}

export function buildMatchContext(now: Date, timezone: string = DEFAULT_TIMEZONE): MatchContext {
	const { localDate, time, weekday } = localDateAndTime(now, timezone)
	return { localDate, now, time, weekday }
}

export function shouldFireTask(row: ScheduledTaskRow, ctx: MatchContext): { disableAfterFire: boolean, fire: boolean, localDate: null | string, skipReason?: string } {
	const recurrence = row.recurrence

	if (recurrence.type === 'once') {
		if (ctx.now.getTime() < recurrence.onceAtMs)
			return { disableAfterFire: true, fire: false, localDate: null }
		if (row.lastFiredLocalDate != null)
			return { disableAfterFire: true, fire: false, localDate: null }
		return { disableAfterFire: true, fire: true, localDate: null }
	}

	const timezone = recurrence.timezone ?? DEFAULT_TIMEZONE
	const local = localDateAndTime(ctx.now, timezone)

	if (row.lastFiredLocalDate === local.localDate)
		return { disableAfterFire: false, fire: false, localDate: local.localDate, skipReason: 'already_fired_today' }

	if (local.time !== recurrence.time)
		return { disableAfterFire: false, fire: false, localDate: local.localDate, skipReason: 'time_mismatch' }

	switch (recurrence.type) {
		case 'daily':
			return { disableAfterFire: false, fire: true, localDate: local.localDate }
		case 'weekly':
			if (!recurrence.weekdays.includes(local.weekday))
				return { disableAfterFire: false, fire: false, localDate: local.localDate, skipReason: 'weekday_mismatch' }
			return { disableAfterFire: false, fire: true, localDate: local.localDate }
		case 'cn_workday': {
			const workday = isCnWorkday(local.localDate)
			if (workday == null)
				return { disableAfterFire: false, fire: false, localDate: local.localDate, skipReason: 'cn_workday_data_unavailable' }
			if (!workday)
				return { disableAfterFire: false, fire: false, localDate: local.localDate, skipReason: 'not_cn_workday' }
			return { disableAfterFire: false, fire: true, localDate: local.localDate }
		}
		default:
			return { disableAfterFire: false, fire: false, localDate: local.localDate, skipReason: 'unknown_type' }
	}
}
