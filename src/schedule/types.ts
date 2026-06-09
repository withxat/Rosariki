export type RecurrenceType = 'cn_workday' | 'daily' | 'once' | 'weekly'

export interface CnWorkdayRecurrence {
	time: string
	timezone?: string
	type: 'cn_workday'
}

export interface DailyRecurrence {
	time: string
	timezone?: string
	type: 'daily'
}

export interface WeeklyRecurrence {
	time: string
	timezone?: string
	type: 'weekly'
	weekdays: number[]
}

export interface OnceRecurrence {
	onceAtMs: number
	type: 'once'
}

export type Recurrence = CnWorkdayRecurrence | DailyRecurrence | OnceRecurrence | WeeklyRecurrence

export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseTime(time: string): null | { hour: number, minute: number } {
	const match = TIME_RE.exec(time)
	if (!match)
		return null
	return { hour: Number(match[1]), minute: Number(match[2]) }
}

export function validateRecurrence(recurrence: unknown): Recurrence {
	if (recurrence == null || typeof recurrence !== 'object')
		throw new Error('recurrence must be an object.')

	const r = recurrence as Record<string, unknown>
	const type = r.type
	if (type !== 'cn_workday' && type !== 'daily' && type !== 'weekly' && type !== 'once')
		throw new Error('recurrence.type must be cn_workday, daily, weekly, or once.')

	if (type === 'once') {
		const onceAtMs = r.onceAtMs
		if (typeof onceAtMs !== 'number' || !Number.isFinite(onceAtMs))
			throw new Error('recurrence.onceAtMs must be a finite number for once schedules.')
		if (onceAtMs <= Date.now())
			throw new Error('recurrence.onceAtMs must be in the future for once schedules.')
		return { onceAtMs, type: 'once' }
	}

	const time = r.time
	if (typeof time !== 'string' || parseTime(time) == null)
		throw new Error('recurrence.time must be HH:MM (24h) for recurring schedules.')

	const timezone = r.timezone
	if (timezone != null && typeof timezone !== 'string')
		throw new Error('recurrence.timezone must be a string when set.')

	if (type === 'weekly') {
		const weekdays = r.weekdays
		if (!Array.isArray(weekdays) || weekdays.length === 0)
			throw new Error('recurrence.weekdays must be a non-empty array for weekly schedules.')
		for (const d of weekdays) {
			if (typeof d !== 'number' || d < 1 || d > 7 || !Number.isInteger(d))
				throw new Error('recurrence.weekdays entries must be integers 1 (Mon) through 7 (Sun).')
		}
		return {
			time,
			type: 'weekly',
			...(timezone != null ? { timezone } : {}),
			weekdays,
		}
	}

	if (type === 'cn_workday')
		return { time, type: 'cn_workday', ...(timezone != null ? { timezone } : {}) }

	return { time, type: 'daily', ...(timezone != null ? { timezone } : {}) }
}
