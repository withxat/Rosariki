import { describe, expect, it } from 'vitest';

import { computeSlackReplyPlacement, renderSlackReplyPlacementXml } from './slack-reply-placement';
import type { RenderedContext } from '../rendering/types';

const seg = (
  receivedAtMs: number,
  opts: {
    messageId: string;
    replyToMessageId?: string;
    mentionsMe?: boolean;
    repliesToMe?: boolean;
    isMyself?: boolean;
  },
) => ({
  receivedAtMs,
  content: [{ type: 'text' as const, text: '' }],
  messageId: opts.messageId,
  ...(opts.replyToMessageId && { replyToMessageId: opts.replyToMessageId }),
  ...(opts.mentionsMe && { mentionsMe: true }),
  ...(opts.repliesToMe && { repliesToMe: true }),
  ...(opts.isMyself && { isMyself: true }),
});

describe('computeSlackReplyPlacement', () => {
  it('returns undefined when no new external message segments', () => {
    expect(computeSlackReplyPlacement([], 0)).toBeUndefined();
    expect(computeSlackReplyPlacement([
      seg(100, { messageId: '1.0', isMyself: true }),
    ], 50)).toBeUndefined();
  });

  it('thread-required when someone replied to the bot', () => {
    const rc: RenderedContext = [
      seg(200, { messageId: '200.1', repliesToMe: true, replyToMessageId: '200.0' }),
    ];
    const p = computeSlackReplyPlacement(rc, 100);
    expect(p).toEqual({
      mode: 'thread-required',
      triggeringMessageId: '200.1',
      suggestedReplyTo: '200.0',
      inThread: true,
      threadRootMessageId: '200.0',
    });
  });

  it('thread-default for channel @mention without in-thread', () => {
    const rc: RenderedContext = [
      seg(200, { messageId: '200.5', mentionsMe: true }),
    ];
    const p = computeSlackReplyPlacement(rc, 100);
    expect(p).toMatchObject({
      mode: 'thread-default',
      triggeringMessageId: '200.5',
      suggestedReplyTo: '200.5',
      inThread: false,
    });
  });

  it('thread-required for @mention inside an existing thread', () => {
    const rc: RenderedContext = [
      seg(200, { messageId: '200.2', mentionsMe: true, replyToMessageId: '200.0' }),
    ];
    const p = computeSlackReplyPlacement(rc, 100);
    expect(p?.mode).toBe('thread-required');
    expect(p?.suggestedReplyTo).toBe('200.0');
  });

  it('prefers latest reply-to-bot over older mention', () => {
    const rc: RenderedContext = [
      seg(150, { messageId: '150.0', mentionsMe: true }),
      seg(200, { messageId: '200.1', repliesToMe: true }),
    ];
    const p = computeSlackReplyPlacement(rc, 100);
    expect(p?.triggeringMessageId).toBe('200.1');
    expect(p?.mode).toBe('thread-required');
  });

  it('returns undefined for new messages without mention or reply', () => {
    const rc: RenderedContext = [
      seg(200, { messageId: '200.0' }),
    ];
    expect(computeSlackReplyPlacement(rc, 100)).toBeUndefined();
  });
});

describe('renderSlackReplyPlacementXml', () => {
  it('renders required placement block', () => {
    const xml = renderSlackReplyPlacementXml({
      mode: 'thread-required',
      triggeringMessageId: '1.002',
      suggestedReplyTo: '1.001',
      inThread: true,
      threadRootMessageId: '1.001',
    });
    expect(xml).toContain('mode="thread-required"');
    expect(xml).toContain('<suggested-reply-to>1.001</suggested-reply-to>');
    expect(xml).toContain('MUST set reply_to');
  });
});
