import { createTool, type CahciuaTool } from './tools';

export interface ScheduleToolDeps {
  createSchedule: (params: {
    runAtMs: number;
    instruction: string;
    repeatEverySec?: number;
  }) => number;
  listSchedules: () => {
    id: number;
    run_at_ms: number;
    instruction: string;
    repeat_every_sec: number | null;
    created_at_ms: number;
  }[];
  cancelSchedule: (scheduleId: number) => boolean;
}

const parseRunAtMs = (input: { run_at?: string; delay_sec?: number }): number => {
  const hasRunAt = input.run_at != null && input.run_at.length > 0;
  const hasDelay = input.delay_sec != null;
  if (hasRunAt === hasDelay)
    throw new Error('Provide exactly one of run_at (ISO-8601) or delay_sec (seconds from now).');

  if (hasDelay) {
    if (input.delay_sec! < 1)
      throw new Error('delay_sec must be at least 1.');
    return Date.now() + input.delay_sec! * 1000;
  }

  const parsed = Date.parse(input.run_at!);
  if (Number.isNaN(parsed))
    throw new Error(`Invalid run_at: ${input.run_at}`);
  return parsed;
};

export const createScheduleWakeTool = (deps: ScheduleToolDeps): CahciuaTool =>
  createTool({
    name: 'schedule_wake',
    description: 'Schedule a future wake-up in this channel. At fire time you will receive a scheduled_wake runtime event with your instruction — you must then compose and send the message yourself (not pre-written text). Use a short intent (topic/reminder), not the final message body.',
    parameters: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'What you should do when the schedule fires (intent/reminder), e.g. "Post the daily standup prompt" or "Remind the channel about the deploy window".',
        },
        run_at: {
          type: 'string',
          description: 'Absolute fire time in ISO-8601 (local offset or Z). Mutually exclusive with delay_sec.',
        },
        delay_sec: {
          type: 'number',
          description: 'Fire this many seconds from now. Mutually exclusive with run_at.',
        },
        repeat_every_sec: {
          type: 'number',
          description: 'If set, reschedule after each fire by this interval (seconds). Omit for one-shot.',
        },
      },
      required: ['instruction'],
    },
    execute: input => {
      const { instruction, run_at, delay_sec, repeat_every_sec } = input as {
        instruction: string;
        run_at?: string;
        delay_sec?: number;
        repeat_every_sec?: number;
      };
      const trimmed = instruction.trim();
      if (!trimmed)
        throw new Error('instruction must not be empty.');

      const runAtMs = parseRunAtMs({ run_at, delay_sec });
      if (runAtMs <= Date.now())
        throw new Error('Scheduled time must be in the future.');

      if (repeat_every_sec != null && repeat_every_sec < 60)
        throw new Error('repeat_every_sec must be at least 60 when set.');

      const id = deps.createSchedule({
        runAtMs,
        instruction: trimmed,
        repeatEverySec: repeat_every_sec,
      });

      return {
        content: JSON.stringify({
          ok: true,
          schedule_id: id,
          run_at_ms: runAtMs,
          run_at_iso: new Date(runAtMs).toISOString(),
          repeat_every_sec: repeat_every_sec ?? null,
        }),
        requiresFollowUp: false,
      };
    },
  });

export const createListScheduledWakesTool = (deps: ScheduleToolDeps): CahciuaTool =>
  createTool({
    name: 'list_scheduled_wakes',
    description: 'List active scheduled wake-ups for this channel.',
    parameters: { type: 'object', properties: {} },
    execute: () => ({
      content: JSON.stringify({ schedules: deps.listSchedules() }),
      requiresFollowUp: false,
    }),
  });

export const createCancelScheduledWakeTool = (deps: ScheduleToolDeps): CahciuaTool =>
  createTool({
    name: 'cancel_scheduled_wake',
    description: 'Cancel an active scheduled wake by schedule_id from schedule_wake or list_scheduled_wakes.',
    parameters: {
      type: 'object',
      properties: {
        schedule_id: { type: 'number', description: 'ID returned by schedule_wake.' },
      },
      required: ['schedule_id'],
    },
    execute: input => {
      const { schedule_id } = input as { schedule_id: number };
      const ok = deps.cancelSchedule(schedule_id);
      if (!ok)
        throw new Error(`No active schedule with id ${schedule_id} in this channel.`);
      return {
        content: JSON.stringify({ ok: true, schedule_id }),
        requiresFollowUp: false,
      };
    },
  });
