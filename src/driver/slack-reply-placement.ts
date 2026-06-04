import type { RenderedContext, RenderedContextSegment } from '../rendering/types';

export type SlackReplyPlacementMode = 'thread-required' | 'thread-default';

export interface SlackReplyPlacement {
  mode: SlackReplyPlacementMode;
  triggeringMessageId: string;
  suggestedReplyTo: string;
  inThread: boolean;
  threadRootMessageId?: string;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const latestMatching = (
  segments: RenderedContextSegment[],
  pred: (seg: RenderedContextSegment) => boolean,
): RenderedContextSegment | undefined => {
  let best: RenderedContextSegment | undefined;
  for (const seg of segments) {
    if (!pred(seg)) continue;
    if (!best || seg.receivedAtMs > best.receivedAtMs) best = seg;
  }
  return best;
};

/**
 * Derive Slack thread vs channel placement from new RC segments since lastProcessedMs.
 * Returns undefined when there is no @/reply trigger (e.g. probe-only activation).
 */
export const computeSlackReplyPlacement = (
  rc: RenderedContext,
  lastProcessedMs: number,
): SlackReplyPlacement | undefined => {
  const candidates = rc.filter(seg =>
    seg.messageId != null
    && seg.receivedAtMs > lastProcessedMs
    && !seg.isMyself
    && !seg.isRuntimeEvent);
  if (candidates.length === 0) return undefined;

  const replySeg = latestMatching(candidates, seg => !!seg.repliesToMe);
  const mentionSeg = latestMatching(candidates, seg => !!seg.mentionsMe);
  const trigger = replySeg ?? mentionSeg;
  if (!trigger?.messageId) return undefined;

  const inThread = !!trigger.replyToMessageId;
  const threadRoot = trigger.replyToMessageId;
  const suggestedReplyTo = threadRoot ?? trigger.messageId;

  const mode: SlackReplyPlacementMode =
    (replySeg != null || inThread) ? 'thread-required' : 'thread-default';

  return {
    mode,
    triggeringMessageId: trigger.messageId,
    suggestedReplyTo,
    inThread,
    ...(threadRoot && { threadRootMessageId: threadRoot }),
  };
};

export const renderSlackReplyPlacementXml = (placement: SlackReplyPlacement): string => {
  const lines = [
    `<slack-reply-placement mode="${placement.mode}" in-thread="${placement.inThread}">`,
    `<triggering-message-id>${escapeXml(placement.triggeringMessageId)}</triggering-message-id>`,
    `<suggested-reply-to>${escapeXml(placement.suggestedReplyTo)}</suggested-reply-to>`,
  ];
  if (placement.threadRootMessageId && placement.threadRootMessageId !== placement.suggestedReplyTo) {
    lines.push(`<thread-root-id>${escapeXml(placement.threadRootMessageId)}</thread-root-id>`);
  }
  if (placement.mode === 'thread-required') {
    lines.push('<rule>You MUST set reply_to on send_message to the suggested-reply-to value. Omit reply_to only when you deliberately broadcast a new top-level channel message for everyone.</rule>');
  } else {
    lines.push('<rule>Default: set reply_to to suggested-reply-to so the reply stays under the triggering message. Omit reply_to only when the whole channel should see a new top-level message.</rule>');
  }
  lines.push('</slack-reply-placement>');
  return lines.join('\n');
};
