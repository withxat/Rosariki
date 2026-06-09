export interface RuntimeTaskCompletedEvent {
	chatId: string
	finalSummary: string
	hasFullOutput: boolean
	intention?: string
	kind: 'task_completed'
	receivedAtMs: number
	taskId: number
	taskType: string
	timestampSec: number
	type: 'runtime'
	utcOffsetMin: number
}

export interface RuntimeScheduleTriggeredEvent {
	chatId: string
	instruction: string
	kind: 'schedule_triggered'
	receivedAtMs: number
	scheduleId: number
	scheduleName?: string
	timestampSec: number
	type: 'runtime'
	utcOffsetMin: number
}

export type RuntimeEvent = RuntimeScheduleTriggeredEvent | RuntimeTaskCompletedEvent

export interface RuntimeTaskCompletedData {
	finalSummary: string
	hasFullOutput: boolean
	intention?: string
	kind: 'task_completed'
	taskId: number
	taskType: string
}

export interface RuntimeScheduleTriggeredData {
	instruction: string
	kind: 'schedule_triggered'
	scheduleId: number
	scheduleName?: string
}

export type RuntimeEventData = RuntimeScheduleTriggeredData | RuntimeTaskCompletedData

export function buildScheduleTriggeredRuntimeEvent(params: {
	chatId: string
	instruction: string
	receivedAtMs?: number
	scheduleId: number
	scheduleName?: string
	utcOffsetMin?: number
}): RuntimeScheduleTriggeredEvent {
	const receivedAtMs = params.receivedAtMs ?? Date.now()
	return {
		chatId: params.chatId,
		instruction: params.instruction,
		kind: 'schedule_triggered',
		receivedAtMs,
		scheduleId: params.scheduleId,
		scheduleName: params.scheduleName,
		timestampSec: Math.floor(receivedAtMs / 1000),
		type: 'runtime',
		utcOffsetMin: params.utcOffsetMin ?? -new Date().getTimezoneOffset(),
	}
}
