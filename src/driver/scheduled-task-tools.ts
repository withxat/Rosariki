import type { CahciuaTool } from './tools'

import { createTool } from './tools'

export interface ScheduledTaskToolDeps {
	cancelSchedule: (scheduleId: number) => boolean
	createSchedule: (params: {
		instruction: string
		name?: string
		recurrence: unknown
	}) => number
	listSchedules: () => {
		created_at_ms: number
		id: number
		instruction: string
		name: null | string
		recurrence: unknown
	}[]
}

export function createScheduleTool(deps: ScheduledTaskToolDeps): CahciuaTool {
	return createTool({
		description: 'Create a recurring or one-shot scheduled task in this channel. At fire time you receive a schedule-triggered runtime event with the instruction — compose and send the message then (instruction = intent, not final text). Supports cn_workday (China workdays incl.调休), daily, weekly, and once.',
		execute: (input) => {
			const { instruction, name, recurrence } = input as {
				instruction: string
				name?: string
				recurrence: unknown
			}
			const id = deps.createSchedule({ instruction, name, recurrence })
			return {
				content: JSON.stringify({ ok: true, schedule_id: id }),
				requiresFollowUp: false,
			}
		},
		name: 'create_schedule',
		parameters: {
			properties: {
				instruction: {
					description: 'What you should do when the schedule fires (intent/reminder), e.g. "Remind everyone to order lunch, keep it light and casual".',
					type: 'string',
				},
				name: {
					description: 'Optional label for list/cancel.',
					type: 'string',
				},
				recurrence: {
					description: 'Schedule rule. cn_workday/daily/weekly need time (HH:MM) and optional timezone (default Asia/Shanghai). weekly needs weekdays (1=Mon…7=Sun). once needs onceAtMs (epoch ms).',
					properties: {
						onceAtMs: { description: 'One-shot fire time (epoch ms).', type: 'number' },
						time: { description: 'HH:MM in recurrence timezone.', type: 'string' },
						timezone: { description: 'IANA timezone, e.g. Asia/Shanghai.', type: 'string' },
						type: { enum: ['cn_workday', 'daily', 'weekly', 'once'], type: 'string' },
						weekdays: { description: '1=Mon … 7=Sun for weekly.', items: { type: 'number' }, type: 'array' },
					},
					required: ['type'],
					type: 'object',
				},
			},
			required: ['instruction', 'recurrence'],
			type: 'object',
		},
	})
}

export function createListSchedulesTool(deps: ScheduledTaskToolDeps): CahciuaTool {
	return createTool({
		description: 'List active scheduled tasks for this channel.',
		execute: () => ({
			content: JSON.stringify({ schedules: deps.listSchedules() }),
			requiresFollowUp: false,
		}),
		name: 'list_schedules',
		parameters: { properties: {}, type: 'object' },
	})
}

export function createCancelScheduleTool(deps: ScheduledTaskToolDeps): CahciuaTool {
	return createTool({
		description: 'Disable a scheduled task by schedule_id from create_schedule or list_schedules.',
		execute: (input) => {
			const { schedule_id } = input as { schedule_id: number }
			const ok = deps.cancelSchedule(schedule_id)
			if (!ok)
				throw new Error(`No active schedule with id ${schedule_id} in this channel.`)
			return {
				content: JSON.stringify({ ok: true, schedule_id }),
				requiresFollowUp: false,
			}
		},
		name: 'cancel_schedule',
		parameters: {
			properties: {
				schedule_id: { description: 'ID returned by create_schedule.', type: 'number' },
			},
			required: ['schedule_id'],
			type: 'object',
		},
	})
}
