import { and, eq, lte } from 'drizzle-orm';

import type { DB } from './client';
import { scheduledWakes } from './schema';

export interface ScheduledWakeRow {
  id: number;
  chatId: string;
  runAtMs: number;
  instruction: string;
  repeatIntervalMs: number | null;
  enabled: boolean;
  createdAtMs: number;
  lastFiredAtMs: number | null;
}

const toRow = (row: typeof scheduledWakes.$inferSelect): ScheduledWakeRow => ({
  id: row.id,
  chatId: row.chatId,
  runAtMs: row.runAtMs,
  instruction: row.instruction,
  repeatIntervalMs: row.repeatIntervalMs ?? null,
  enabled: row.enabled,
  createdAtMs: row.createdAtMs,
  lastFiredAtMs: row.lastFiredAtMs ?? null,
});

export const insertScheduledWake = (
  db: DB,
  params: {
    chatId: string;
    runAtMs: number;
    instruction: string;
    repeatIntervalMs?: number;
  },
): number => {
  const createdAtMs = Date.now();
  const result = db.insert(scheduledWakes).values({
    chatId: params.chatId,
    runAtMs: params.runAtMs,
    instruction: params.instruction,
    repeatIntervalMs: params.repeatIntervalMs ?? null,
    enabled: true,
    createdAtMs,
  }).run();
  return Number(result.lastInsertRowid);
};

export const listScheduledWakesForChat = (db: DB, chatId: string): ScheduledWakeRow[] =>
  db.select().from(scheduledWakes)
    .where(and(eq(scheduledWakes.chatId, chatId), eq(scheduledWakes.enabled, true)))
    .orderBy(scheduledWakes.runAtMs)
    .all()
    .map(toRow);

export const cancelScheduledWake = (db: DB, chatId: string, scheduleId: number): boolean => {
  const result = db.update(scheduledWakes)
    .set({ enabled: false })
    .where(and(
      eq(scheduledWakes.id, scheduleId),
      eq(scheduledWakes.chatId, chatId),
      eq(scheduledWakes.enabled, true),
    ))
    .run();
  return result.changes > 0;
};

export const listDueScheduledWakes = (db: DB, nowMs: number): ScheduledWakeRow[] =>
  db.select().from(scheduledWakes)
    .where(and(eq(scheduledWakes.enabled, true), lte(scheduledWakes.runAtMs, nowMs)))
    .orderBy(scheduledWakes.runAtMs)
    .all()
    .map(toRow);

export const advanceScheduledWakeAfterFire = (db: DB, row: ScheduledWakeRow, firedAtMs: number): void => {
  if (row.repeatIntervalMs != null && row.repeatIntervalMs > 0) {
    db.update(scheduledWakes)
      .set({
        runAtMs: firedAtMs + row.repeatIntervalMs,
        lastFiredAtMs: firedAtMs,
      })
      .where(eq(scheduledWakes.id, row.id))
      .run();
    return;
  }
  db.update(scheduledWakes)
    .set({ enabled: false, lastFiredAtMs: firedAtMs })
    .where(eq(scheduledWakes.id, row.id))
    .run();
};
