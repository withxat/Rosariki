import type { Logger } from '@guiiai/logg';

import type { DB } from '../db/client';
import { advanceScheduledWakeAfterFire, listDueScheduledWakes } from '../db/scheduled-wakes';
import type { PipelineEvent } from '../projection/reduce';
import { buildScheduledWakeRuntimeEvent } from '../runtime-event';
import type { RenderedContext } from '../rendering/types';

export interface ScheduledWakeSchedulerDeps {
  db: DB;
  configuredChatIds: Set<string>;
  persistEvent: (event: PipelineEvent) => void;
  pushPipelineEvent: (chatId: string, event: PipelineEvent) => RenderedContext | undefined;
  handleDriverEvent: (chatId: string, rc: RenderedContext) => void;
  logger: Logger;
  pollIntervalMs?: number;
}

export const createScheduledWakeScheduler = (deps: ScheduledWakeSchedulerDeps) => {
  const log = deps.logger.withContext('scheduler');
  let ticking = false;

  const fireRow = (row: import('../db/scheduled-wakes').ScheduledWakeRow) => {
    const firedAtMs = Date.now();
    advanceScheduledWakeAfterFire(deps.db, row, firedAtMs);

    const runtimeEvent = buildScheduledWakeRuntimeEvent({
      chatId: row.chatId,
      scheduleId: row.id,
      instruction: row.instruction,
      receivedAtMs: firedAtMs,
    });

    deps.persistEvent(runtimeEvent);
    if (!deps.configuredChatIds.has(row.chatId)) {
      log.withFields({ scheduleId: row.id, chatId: row.chatId }).log('Scheduled wake persisted (chat not in config)');
      return;
    }

    const rc = deps.pushPipelineEvent(row.chatId, runtimeEvent);
    if (rc)
      deps.handleDriverEvent(row.chatId, rc);

    log.withFields({
      scheduleId: row.id,
      chatId: row.chatId,
      repeatIntervalMs: row.repeatIntervalMs,
    }).log('Scheduled wake fired');
  };

  const tick = () => {
    if (ticking) return;
    ticking = true;
    try {
      const due = listDueScheduledWakes(deps.db, Date.now());
      for (const row of due)
        fireRow(row);
    } finally {
      ticking = false;
    }
  };

  const intervalMs = deps.pollIntervalMs ?? 15_000;
  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    stop: () => clearInterval(timer),
    tick,
  };
};
