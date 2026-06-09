import type { Recurrence } from '../schedule/types'
import type { DB } from './client'

import { and, eq } from 'drizzle-orm'

import { scheduledTasks } from './schema'

export interface ScheduledTaskRow {
	chatId: string
	createdAtMs: number
	enabled: boolean
	id: number
	instruction: string
	lastFiredLocalDate: null | string
	name: null | string
	recurrence: Recurrence
}

function toRow(row: typeof scheduledTasks.$inferSelect): ScheduledTaskRow {
	return {
		chatId: row.chatId,
		createdAtMs: row.createdAtMs,
		enabled: row.enabled,
		id: row.id,
		instruction: row.instruction,
		lastFiredLocalDate: row.lastFiredLocalDate ?? null,
		name: row.name ?? null,
		recurrence: row.recurrence,
	}
}

export function insertScheduledTask(db: DB, params: {
	chatId: string
	instruction: string
	name?: string
	recurrence: Recurrence
}): number {
	const createdAtMs = Date.now()
	const result = db.insert(scheduledTasks).values({
		chatId: params.chatId,
		createdAtMs,
		enabled: true,
		instruction: params.instruction,
		name: params.name ?? null,
		recurrence: params.recurrence,
	}).run()
	return Number(result.lastInsertRowid)
}

export function listEnabledScheduledTasks(db: DB): ScheduledTaskRow[] {
	return db.select().from(scheduledTasks).where(eq(scheduledTasks.enabled, true)).orderBy(scheduledTasks.id).all().map(toRow)
}

export function listScheduledTasksForChat(db: DB, chatId: string): ScheduledTaskRow[] {
	return db.select().from(scheduledTasks).where(and(eq(scheduledTasks.chatId, chatId), eq(scheduledTasks.enabled, true))).orderBy(scheduledTasks.id).all().map(toRow)
}

export function cancelScheduledTask(db: DB, chatId: string, scheduleId: number): boolean {
	const result = db.update(scheduledTasks)
		.set({ enabled: false })
		.where(and(
			eq(scheduledTasks.id, scheduleId),
			eq(scheduledTasks.chatId, chatId),
			eq(scheduledTasks.enabled, true),
		))
		.run()
	return result.changes > 0
}

export function markScheduledTaskFired(db: DB, row: ScheduledTaskRow, localDate: null | string,	disable: boolean): void {
	db.update(scheduledTasks)
		.set({
			...(localDate != null ? { lastFiredLocalDate: localDate } : {}),
			...(disable ? { enabled: false } : {}),
		})
		.where(eq(scheduledTasks.id, row.id))
		.run()
}
