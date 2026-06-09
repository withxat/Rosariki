import type {
	CanonicalAttachment,
	CanonicalDeleteEvent,
	CanonicalEditEvent,
	CanonicalMessageEvent,
	CanonicalServiceEvent,
	CanonicalUser,
	ContentNode,
} from '../adaptation/types'
import type { SlackFileAttachment, SlackMessage, SlackMessageDelete, SlackMessageEdit, SlackReactionEvent, SlackUser } from './types'

import { captureUtcOffset } from '../adaptation'

function adaptUser(user: SlackUser): CanonicalUser {
	return {
		displayName: user.displayName !== '' ? user.displayName : (user.username ?? user.id),
		id: user.id,
		isBot: user.isBot,
		username: user.username,
	}
}

function decodeSlackEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
}

function parseInlineFormatting(text: string): ContentNode[] {
	const nodes: ContentNode[] = []
	const pattern = /```([\s\S]*?)```|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~/g
	let cursor = 0

	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0
		if (index > cursor)
			nodes.push({ text: decodeSlackEntities(text.slice(cursor, index)), type: 'text' })

		if (match[1] != null) {
			nodes.push({ text: decodeSlackEntities(match[1]), type: 'pre' })
		}
		else if (match[2] != null) {
			nodes.push({ text: decodeSlackEntities(match[2]), type: 'code' })
		}
		else if (match[3] != null) {
			nodes.push({ children: [{ text: decodeSlackEntities(match[3]), type: 'text' }], type: 'bold' })
		}
		else if (match[4] != null) {
			nodes.push({ children: [{ text: decodeSlackEntities(match[4]), type: 'text' }], type: 'italic' })
		}
		else if (match[5] != null) {
			nodes.push({ children: [{ text: decodeSlackEntities(match[5]), type: 'text' }], type: 'strikethrough' })
		}

		cursor = index + match[0].length
	}

	if (cursor < text.length)
		nodes.push({ text: decodeSlackEntities(text.slice(cursor)), type: 'text' })

	return nodes
}

function parseSlackToken(token: string): ContentNode | undefined {
	if (token.startsWith('@')) {
		const [userId, label] = token.slice(1).split('|', 2)
		if (!userId)
			return undefined
		return {
			children: [{ text: label ? `@${label}` : `<@${userId}>`, type: 'text' }],
			type: 'mention',
			userId,
		}
	}

	if (token.startsWith('#')) {
		const [channelId, label] = token.slice(1).split('|', 2)
		return { text: label ? `#${decodeSlackEntities(label)}` : `<#${channelId}>`, type: 'text' }
	}

	if (token.startsWith('!subteam^')) {
		const [subteamId, label] = token.slice('!subteam^'.length).split('|', 2)
		return { text: label ? `@${decodeSlackEntities(label)}` : `<!subteam^${subteamId}>`, type: 'text' }
	}

	if (token.startsWith('!')) {
		const [special, label] = token.slice(1).split('|', 2)
		return { text: label ? `@${decodeSlackEntities(label)}` : `@${special}`, type: 'text' }
	}

	const [url, label] = token.split('|', 2)
	if (/^[a-z][a-z0-9+.-]*:/i.test(url ?? '')) {
		const children = parseInlineFormatting(label ?? url!)
		return { children, type: 'link', url: decodeSlackEntities(url!) }
	}

	return undefined
}

export function parseSlackContent(text: string): ContentNode[] {
	if (!text)
		return []

	const nodes: ContentNode[] = []
	const tokenPattern = /<([^>\n]+)>/g
	let cursor = 0

	for (const match of text.matchAll(tokenPattern)) {
		const index = match.index ?? 0
		if (index > cursor)
			nodes.push(...parseInlineFormatting(text.slice(cursor, index)))

		const parsed = parseSlackToken(match[1]!)
		nodes.push(parsed ?? { text: decodeSlackEntities(match[0]), type: 'text' })
		cursor = index + match[0].length
	}

	if (cursor < text.length)
		nodes.push(...parseInlineFormatting(text.slice(cursor)))

	return nodes
}

function inferAttachmentType(file: SlackFileAttachment): CanonicalAttachment['type'] {
	const mime = file.mimeType ?? ''
	const fileType = file.fileType ?? ''
	if (mime.startsWith('image/'))
		return 'photo'
	if (mime.startsWith('video/'))
		return fileType === 'gif' ? 'animation' : 'video'
	if (mime.startsWith('audio/'))
		return 'audio'
	return 'document'
}

function adaptFileAttachment(file: SlackFileAttachment): CanonicalAttachment {
	return {
		platformFileId: file.id,
		type: inferAttachmentType(file),
		...(file.mimeType && { mimeType: file.mimeType }),
		...((file.name ?? file.title) && { fileName: file.name ?? file.title }),
		...(file.width != null && { width: file.width }),
		...(file.height != null && { height: file.height }),
		...(file.duration != null && { duration: file.duration }),
		...(file.thumbnailWebp && { thumbnailWebp: file.thumbnailWebp }),
	}
}

function adaptFileAttachments(files?: SlackFileAttachment[]): CanonicalAttachment[] {
	return files?.map(adaptFileAttachment) ?? []
}

export function adaptSlackMessage(msg: SlackMessage): CanonicalMessageEvent {
	const receivedAtMs = msg.receivedAtMs ?? Date.now()
	const event: CanonicalMessageEvent = {
		attachments: adaptFileAttachments(msg.files),
		chatId: msg.chatId,
		content: parseSlackContent(msg.text),
		messageId: msg.messageId,
		receivedAtMs,
		timestampSec: msg.date,
		type: 'message',
		utcOffsetMin: msg.utcOffsetMin ?? captureUtcOffset(),
	}
	if (msg.sender)
		event.sender = adaptUser(msg.sender)
	if (msg.replyToMessageId)
		event.replyToMessageId = msg.replyToMessageId
	return event
}

export function adaptSlackEdit(edit: SlackMessageEdit): CanonicalEditEvent {
	const receivedAtMs = edit.receivedAtMs ?? Date.now()
	const event: CanonicalEditEvent = {
		attachments: adaptFileAttachments(edit.files),
		chatId: edit.chatId,
		content: parseSlackContent(edit.text),
		messageId: edit.messageId,
		receivedAtMs,
		timestampSec: edit.editDate,
		type: 'edit',
		utcOffsetMin: edit.utcOffsetMin ?? captureUtcOffset(),
	}
	if (edit.sender)
		event.sender = adaptUser(edit.sender)
	return event
}

export function adaptSlackDelete(del: SlackMessageDelete): CanonicalDeleteEvent {
	const now = del.receivedAtMs ?? Date.now()
	return {
		chatId: del.chatId,
		messageIds: del.messageIds,
		receivedAtMs: now,
		timestampSec: Math.floor(now / 1000),
		type: 'delete',
		utcOffsetMin: del.utcOffsetMin ?? captureUtcOffset(),
	}
}

export function adaptSlackReaction(reaction: SlackReactionEvent): CanonicalServiceEvent {
	const now = reaction.receivedAtMs ?? Date.now()
	return {
		chatId: reaction.chatId,
		type: 'service',
		...(reaction.sender && { actor: adaptUser(reaction.sender) }),
		action: {
			action: 'message_reaction',
			messageId: reaction.messageId,
			operation: reaction.operation,
			reaction: reaction.reaction,
		},
		receivedAtMs: now,
		timestampSec: Math.floor(now / 1000),
		utcOffsetMin: reaction.utcOffsetMin ?? captureUtcOffset(),
	}
}
