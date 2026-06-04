import { describe, expect, it } from 'vitest';

import { reduce, createEmptyIC } from '../projection';
import { render, rcToXml } from '../rendering';
import { buildScheduledWakeRuntimeEvent } from '../runtime-event';

describe('scheduled_wake runtime event', () => {
  it('reduces and renders with instruction for model-authored send', () => {
    const event = buildScheduledWakeRuntimeEvent({
      chatId: 'C1',
      scheduleId: 7,
      instruction: 'Post the daily standup prompt',
      receivedAtMs: 5_000,
      utcOffsetMin: 480,
    });

    const ic = reduce(createEmptyIC('C1'), event);
    const rc = render(ic);
    expect(rc).toHaveLength(1);
    expect(rc[0]!.isRuntimeEvent).toBe(true);
    expect(rc[0]!.isScheduledWake).toBe(true);

    const xml = rcToXml(rc);
    expect(xml).toContain('type="scheduled_wake"');
    expect(xml).toContain('schedule-id="7"');
    expect(xml).toContain('Post the daily standup prompt');
    expect(xml).toContain('Compose and send');
  });
});
