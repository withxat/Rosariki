import { captureUtcOffset } from '../adaptation';
import type { SlackFileAttachment, SlackMessage, SlackMessageDelete, SlackMessageEdit, SlackReactionEvent, SlackUser } from './types';
import type {
  CanonicalAttachment,
  CanonicalDeleteEvent,
  CanonicalEditEvent,
  CanonicalMessageEvent,
  CanonicalServiceEvent,
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

const parseInlineFormatting = (text: string): ContentNode[] => {
  const nodes: ContentNode[] = [];
  const pattern = /```([\s\S]*?)```|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor)
      nodes.push({ type: 'text', text: decodeSlackEntities(text.slice(cursor, index)) });

    if (match[1] != null) {
      nodes.push({ type: 'pre', text: decodeSlackEntities(match[1]) });
    } else if (match[2] != null) {
      nodes.push({ type: 'code', text: decodeSlackEntities(match[2]) });
    } else if (match[3] != null) {
      nodes.push({ type: 'bold', children: [{ type: 'text', text: decodeSlackEntities(match[3]) }] });
    } else if (match[4] != null) {
      nodes.push({ type: 'italic', children: [{ type: 'text', text: decodeSlackEntities(match[4]) }] });
    } else if (match[5] != null) {
      nodes.push({ type: 'strikethrough', children: [{ type: 'text', text: decodeSlackEntities(match[5]) }] });
    }

    cursor = index + match[0].length;
  }

  if (cursor < text.length)
    nodes.push({ type: 'text', text: decodeSlackEntities(text.slice(cursor)) });

  return nodes;
};

const parseSlackToken = (token: string): ContentNode | undefined => {
  if (token.startsWith('@')) {
    const [userId, label] = token.slice(1).split('|', 2);
    if (!userId) return undefined;
    return {
      type: 'mention',
      userId,
      children: [{ type: 'text', text: label ? `@${label}` : `<@${userId}>` }],
    };
  }

  if (token.startsWith('#')) {
    const [channelId, label] = token.slice(1).split('|', 2);
    return { type: 'text', text: label ? `#${decodeSlackEntities(label)}` : `<#${channelId}>` };
  }

  if (token.startsWith('!subteam^')) {
    const [subteamId, label] = token.slice('!subteam^'.length).split('|', 2);
    return { type: 'text', text: label ? `@${decodeSlackEntities(label)}` : `<!subteam^${subteamId}>` };
  }

  if (token.startsWith('!')) {
    const [special, label] = token.slice(1).split('|', 2);
    return { type: 'text', text: label ? `@${decodeSlackEntities(label)}` : `@${special}` };
  }

  const [url, label] = token.split('|', 2);
  if (/^[a-z][a-z0-9+.-]*:/i.test(url ?? '')) {
    const children = parseInlineFormatting(label ?? url!);
    return { type: 'link', url: decodeSlackEntities(url!), children };
  }

  return undefined;
};

export const parseSlackContent = (text: string): ContentNode[] => {
  if (!text) return [];

  const nodes: ContentNode[] = [];
  const tokenPattern = /<([^>\n]+)>/g;
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor)
      nodes.push(...parseInlineFormatting(text.slice(cursor, index)));

    const parsed = parseSlackToken(match[1]!);
    nodes.push(parsed ?? { type: 'text', text: decodeSlackEntities(match[0]) });
    cursor = index + match[0].length;
  }

  if (cursor < text.length)
    nodes.push(...parseInlineFormatting(text.slice(cursor)));

  return nodes;
};

const inferAttachmentType = (file: SlackFileAttachment): CanonicalAttachment['type'] => {
  const mime = file.mimeType ?? '';
  const fileType = file.fileType ?? '';
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return fileType === 'gif' ? 'animation' : 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
};

const adaptFileAttachment = (file: SlackFileAttachment): CanonicalAttachment => ({
  type: inferAttachmentType(file),
  platformFileId: file.id,
  ...(file.mimeType && { mimeType: file.mimeType }),
  ...((file.name ?? file.title) && { fileName: file.name ?? file.title }),
  ...(file.width != null && { width: file.width }),
  ...(file.height != null && { height: file.height }),
  ...(file.duration != null && { duration: file.duration }),
  ...(file.thumbnailWebp && { thumbnailWebp: file.thumbnailWebp }),
});

const adaptFileAttachments = (files?: SlackFileAttachment[]): CanonicalAttachment[] =>
  files?.map(adaptFileAttachment) ?? [];

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
    attachments: adaptFileAttachments(msg.files),
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
    attachments: adaptFileAttachments(edit.files),
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

export const adaptSlackReaction = (reaction: SlackReactionEvent): CanonicalServiceEvent => {
  const now = reaction.receivedAtMs ?? Date.now();
  return {
    type: 'service',
    chatId: reaction.chatId,
    ...(reaction.sender && { actor: adaptUser(reaction.sender) }),
    receivedAtMs: now,
    timestampSec: Math.floor(now / 1000),
    utcOffsetMin: reaction.utcOffsetMin ?? captureUtcOffset(),
    action: {
      action: 'message_reaction',
      messageId: reaction.messageId,
      reaction: reaction.reaction,
      operation: reaction.operation,
    },
  };
};
