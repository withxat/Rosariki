import { captureUtcOffset } from '../adaptation';
import type { SlackMessage, SlackMessageDelete, SlackMessageEdit, SlackUser } from './types';
import type {
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalMessageEvent,
  CanonicalUser,
  ContentNode,
} from '../adaptation/types';

const adaptUser = (user: SlackUser): CanonicalUser => ({
  id: user.id,
  displayName: user.displayName !== '' ? user.displayName : (user.username ?? user.id),
  username: user.username,
  isBot: user.isBot,
});

const decodeSlackEntities = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

export const parseSlackContent = (text: string): ContentNode[] => {
  if (!text) return [];

  const nodes: ContentNode[] = [];
  const mentionPattern = /<@([A-Z0-9]+)(?:\|([^>]+))?>/g;
  let cursor = 0;

  for (const match of text.matchAll(mentionPattern)) {
    const index = match.index ?? 0;
    if (index > cursor)
      nodes.push({ type: 'text', text: decodeSlackEntities(text.slice(cursor, index)) });

    const userId = match[1]!;
    const label = match[2] ? `@${match[2]}` : `<@${userId}>`;
    nodes.push({
      type: 'mention',
      userId,
      children: [{ type: 'text', text: label }],
    });
    cursor = index + match[0].length;
  }

  if (cursor < text.length)
    nodes.push({ type: 'text', text: decodeSlackEntities(text.slice(cursor)) });

  return nodes;
};

export const adaptSlackMessage = (msg: SlackMessage): CanonicalMessageEvent => {
  const receivedAtMs = msg.receivedAtMs ?? Date.now();
  const event: CanonicalMessageEvent = {
    type: 'message',
    chatId: msg.chatId,
    messageId: msg.messageId,
    receivedAtMs,
    timestampSec: msg.date,
    utcOffsetMin: msg.utcOffsetMin ?? captureUtcOffset(),
    content: parseSlackContent(msg.text),
    attachments: [],
  };
  if (msg.sender) event.sender = adaptUser(msg.sender);
  if (msg.replyToMessageId) event.replyToMessageId = msg.replyToMessageId;
  return event;
};

export const adaptSlackEdit = (edit: SlackMessageEdit): CanonicalEditEvent => {
  const receivedAtMs = edit.receivedAtMs ?? Date.now();
  const event: CanonicalEditEvent = {
    type: 'edit',
    chatId: edit.chatId,
    messageId: edit.messageId,
    receivedAtMs,
    timestampSec: edit.editDate,
    utcOffsetMin: edit.utcOffsetMin ?? captureUtcOffset(),
    content: parseSlackContent(edit.text),
    attachments: [],
  };
  if (edit.sender) event.sender = adaptUser(edit.sender);
  return event;
};

export const adaptSlackDelete = (del: SlackMessageDelete): CanonicalDeleteEvent => {
  const now = del.receivedAtMs ?? Date.now();
  return {
    type: 'delete',
    chatId: del.chatId,
    messageIds: del.messageIds,
    receivedAtMs: now,
    timestampSec: Math.floor(now / 1000),
    utcOffsetMin: del.utcOffsetMin ?? captureUtcOffset(),
  };
};
