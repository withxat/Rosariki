import type { Logger } from '@guiiai/logg'

import type { DB } from '../db/client'
import type { ScheduledTaskRow } from '../db/scheduled-tasks'
import type { PipelineEvent } from '../projection/reduce'
import type { RenderedContext } from '../rendering/types'
import type { Recurrence } from './types'

import {
	cancelScheduledTask,
	insertScheduledTask,
	listEnabledScheduledTasks,
	listScheduledTasksForChat,
	markScheduledTaskFired,

} from '../db/scheduled-tasks'
import { buildScheduleTriggeredRuntimeEvent } from '../runtime-event'
import { buildMatchContext, shouldFireTask } from './match'
import { validateRecurrence } from './types'

export interface ScheduleManagerDeps {
	configuredChatIds: Set<string>
	db: DB
	handleDriverEvent: (chatId: string, rc: RenderedContext) => void
	logger: Logger
	persistEvent: (event: PipelineEvent) => void
	pushPipelineEvent: (chatId: string, event: PipelineEvent) => RenderedContext | undefined
	tickIntervalMs?: number
}

export function createScheduleManager(deps: ScheduleManagerDeps) {
	const log = deps.logger.withContext('schedule')
	let ticking = false
	let timer: ReturnType<typeof setInterval> | undefined

	const fireTask = (row: ScheduledTaskRow, localDate: null | string, disableAfterFire: boolean) => {
		const firedAtMs = Date.now()
		markScheduledTaskFired(deps.db, row, localDate, disableAfterFire)

		const runtimeEvent = buildScheduleTriggeredRuntimeEvent({
			chatId: row.chatId,
			instruction: row.instruction,
			receivedAtMs: firedAtMs,
			scheduleId: row.id,
			scheduleName: row.name ?? undefined,
		})

		deps.persistEvent(runtimeEvent)
		if (!deps.configuredChatIds.has(row.chatId)) {
			log.withFields({ chatId: row.chatId, scheduleId: row.id }).log('Scheduled task persisted (chat not in config)')
			return
		}

		const rc = deps.pushPipelineEvent(row.chatId, runtimeEvent)
		if (rc)
			deps.handleDriverEvent(row.chatId, rc)

		log.withFields({
			chatId: row.chatId,
			name: row.name,
			recurrenceType: row.recurrence.type,
			scheduleId: row.id,
		}).log('Scheduled task fired')
	}

	const tick = () => {
		if (ticking)
			return
		ticking = true
		try {
			const now = new Date()
			const ctx = buildMatchContext(now)
			const tasks = listEnabledScheduledTasks(deps.db)

			for (const row of tasks) {
				const result = shouldFireTask(row, ctx)
				if (!result.fire) {
					if (result.skipReason === 'cn_workday_data_unavailable') {
						log.withFields({ localDate: result.localDate, scheduleId: row.id }).error(
							'chinese-days data unavailable for cn_workday task — skipping',
						)
					}
					continue
				}
				fireTask(row, result.localDate, result.disableAfterFire)
			}
		}
		finally {
			ticking = false
		}
	}

	const start = () => {
		if (timer != null)
			return
		const intervalMs = deps.tickIntervalMs ?? 60_000
		timer = setInterval(tick, intervalMs)
		tick()
	}

	const shutdown = () => {
		if (timer != null) {
			clearInterval(timer)
			timer = undefined
		}
	}

	const create = (params: {
		chatId: string
		instruction: string
		name?: string
		recurrence: Recurrence
	}): number =>
		insertScheduledTask(deps.db, params)

	const listForChat = (chatId: string) =>
		listScheduledTasksForChat(deps.db, chatId).map(row => ({
			created_at_ms: row.createdAtMs,
			id: row.id,
			instruction: row.instruction,
			name: row.name,
			recurrence: row.recurrence,
		}))

	const cancel = (chatId: string, scheduleId: number) =>
		cancelScheduledTask(deps.db, chatId, scheduleId)

	return {
		cancel,
		create: (chatId: string, params: { instruction: string, name?: string, recurrence: unknown }) => {
			const trimmed = params.instruction.trim()
			if (!trimmed)
				throw new Error('instruction must not be empty.')
			const recurrence = validateRecurrence(params.recurrence)
			const name = params.name?.trim()
			return create({
				chatId,
				...(name ? { name } : {}),
				instruction: trimmed,
				recurrence,
			})
		},
		listForChat,
		shutdown,
		start,
		tick,
	}
}

export type ScheduleManager = ReturnType<typeof createScheduleManager>
