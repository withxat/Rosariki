import chineseDays from 'chinese-days'

import { DEFAULT_TIMEZONE } from './types'

const WEEKDAY_MAP: Record<string, number> = {
	Fri: 5,
	Mon: 1,
	Sat: 6,
	Sun: 7,
	Thu: 4,
	Tue: 2,
	Wed: 3,
}

export interface LocalDateTime {
	localDate: string
	time: string
	timezone: string
	weekday: number
}

export function localDateAndTime(now: Date, timezone: string = DEFAULT_TIMEZONE): LocalDateTime {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		day: '2-digit',
		hour: '2-digit',
		hour12: false,
		minute: '2-digit',
		month: '2-digit',
		timeZone: timezone,
		weekday: 'short',
		year: 'numeric',
	})

	const parts = formatter.formatToParts(now)
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find(p => p.type === type)?.value ?? ''

	const year = get('year')
	const month = get('month')
	const day = get('day')
	const hour = get('hour')
	const minute = get('minute')
	const weekdayShort = get('weekday')
	const weekday = WEEKDAY_MAP[weekdayShort]
	if (weekday == null)
		throw new Error(`Unknown weekday from Intl: ${weekdayShort}`)

	return {
		localDate: `${year}-${month}-${day}`,
		time: `${hour}:${minute}`,
		timezone,
		weekday,
	}
}

export function isCnWorkday(localDate: string): boolean | null {
	try {
		return chineseDays.isWorkday(localDate)
	}
	catch {
		return null
	}
}
