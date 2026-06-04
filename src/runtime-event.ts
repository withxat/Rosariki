export interface RuntimeTaskCompletedEvent {
  type: 'runtime';
  kind: 'task_completed';
  chatId: string;
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  taskId: number;
  taskType: string;
  intention?: string;
  finalSummary: string;
  hasFullOutput: boolean;
}

export interface RuntimeScheduledWakeEvent {
  type: 'runtime';
  kind: 'scheduled_wake';
  chatId: string;
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  scheduleId: number;
  instruction: string;
}

export type RuntimeEvent = RuntimeTaskCompletedEvent | RuntimeScheduledWakeEvent;

export interface RuntimeTaskCompletedData {
  kind: 'task_completed';
  taskId: number;
  taskType: string;
  intention?: string;
  finalSummary: string;
  hasFullOutput: boolean;
}

export interface RuntimeScheduledWakeData {
  kind: 'scheduled_wake';
  scheduleId: number;
  instruction: string;
}

export type RuntimeEventData = RuntimeTaskCompletedData | RuntimeScheduledWakeData;

export const buildScheduledWakeRuntimeEvent = (params: {
  chatId: string;
  scheduleId: number;
  instruction: string;
  receivedAtMs?: number;
  utcOffsetMin?: number;
}): RuntimeScheduledWakeEvent => {
  const receivedAtMs = params.receivedAtMs ?? Date.now();
  return {
    type: 'runtime',
    kind: 'scheduled_wake',
    chatId: params.chatId,
    receivedAtMs,
    timestampSec: Math.floor(receivedAtMs / 1000),
    utcOffsetMin: params.utcOffsetMin ?? -new Date().getTimezoneOffset(),
    scheduleId: params.scheduleId,
    instruction: params.instruction,
  };
};
