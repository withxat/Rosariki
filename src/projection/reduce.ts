import type {
	CanonicalDeleteEvent,
	CanonicalEditEvent,
	CanonicalIMEvent,
	CanonicalMessageEvent,
	CanonicalServiceEvent,
	CanonicalUser,
} from '../adaptation/types'
import type { RuntimeEvent } from '../runtime-event'
import type { ICMessage, ICSystemEvent, ICUserState, IntermediateContext } from './types'

import { enableMapSet, produce } from 'immer'

import { contentToPlainText } from '../adaptation'

export type PipelineEvent = CanonicalIMEvent | RuntimeEvent

enableMapSet()

function userChanged(a: CanonicalUser, b: CanonicalUser): boolean {
	return a.displayName !== b.displayName || (a.username ?? null) !== (b.username ?? null)
}

function findMessageIndex(nodes: readonly { messageId?: string, type: string }[], messageId: string): number {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i]!
		if (node.type === 'message' && node.messageId === messageId)
			return i
	}
	return -1
}

const REPLY_PREVIEW_MAX = 100

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`
}

function reduceMessage(draft: IntermediateContext, event: CanonicalMessageEvent) {
	// Dedup: skip if a message with the same ID already exists (bypass + userbot race).
	// Merge isSelfSent from the late-arriving synthetic event into the existing node.
	const existingIdx = findMessageIndex(draft.nodes, event.messageId)
	if (existingIdx !== -1) {
		if (event.isSelfSent)
			(draft.nodes[existingIdx] as ICMessage).isSelfSent = true
		return
	}

	// MetaReducer: detect user rename before appending the message
	if (event.sender) {
		const existing = draft.users.get(event.sender.id)

		if (existing && userChanged(existing.user, event.sender)) {
			const systemEvent: ICSystemEvent = {
				kind: 'user_renamed',
				newUser: event.sender,
				oldUser: existing.user,
				receivedAtMs: event.receivedAtMs,
				timestampSec: event.timestampSec,
				type: 'system_event',
				userId: event.sender.id,
				utcOffsetMin: event.utcOffsetMin,
			}
			draft.nodes.push(systemEvent)
		}
	}

	const message: ICMessage = {
		attachments: event.attachments,
		content: event.content,
		messageId: event.messageId,
		receivedAtMs: event.receivedAtMs,
		sender: event.sender,
		timestampSec: event.timestampSec,
		type: 'message',
		utcOffsetMin: event.utcOffsetMin,
	}
	if (event.replyToMessageId) {
		message.replyToMessageId = event.replyToMessageId
		// Snapshot reply target's sender + preview from current IC state
		const targetIdx = findMessageIndex(draft.nodes, event.replyToMessageId)
		if (targetIdx !== -1) {
			const target = draft.nodes[targetIdx] as ICMessage
			message.replyToSender = target.sender
			const plain = contentToPlainText(target.content)
			if (plain)
				message.replyToPreview = truncate(plain, REPLY_PREVIEW_MAX)
			if (target.content.length > 0)
				message.replyToContent = target.content
		}
	}
	if (event.forwardInfo)
		message.forwardInfo = event.forwardInfo
	if (event.isSelfSent)
		message.isSelfSent = true
	draft.nodes.push(message)

	// Update user state
	if (event.sender) {
		const existing = draft.users.get(event.sender.id)
		if (existing) {
			existing.user = event.sender
			existing.lastSeenAtMs = event.receivedAtMs
			existing.messageCount++
		}
		else {
			const state: ICUserState = {
				firstSeenAtMs: event.receivedAtMs,
				lastSeenAtMs: event.receivedAtMs,
				messageCount: 1,
				user: event.sender,
			}
			draft.users.set(event.sender.id, state)
		}
	}
}

function reduceEdit(draft: IntermediateContext, event: CanonicalEditEvent) {
	const idx = findMessageIndex(draft.nodes, event.messageId)
	if (idx === -1)
		return

	const node = draft.nodes[idx] as ICMessage
	node.content = event.content
	node.attachments = event.attachments
	node.editedAtSec = event.timestampSec
	node.editUtcOffsetMin = event.utcOffsetMin
}

function reduceDelete(draft: IntermediateContext, event: CanonicalDeleteEvent) {
	for (const messageId of event.messageIds) {
		const idx = findMessageIndex(draft.nodes, messageId)
		if (idx === -1)
			continue;
		(draft.nodes[idx] as ICMessage).deleted = true
	}
}

function reduceService(draft: IntermediateContext, event: CanonicalServiceEvent) {
	const base = {
		actor: event.actor,
		receivedAtMs: event.receivedAtMs,
		timestampSec: event.timestampSec,
		type: 'system_event' as const,
		utcOffsetMin: event.utcOffsetMin,
	}

	const { action } = event

	switch (action.action) {
		case 'members_joined':
			draft.nodes.push({ ...base, kind: 'members_joined', members: action.members })
			break
		case 'member_left':
			draft.nodes.push({ ...base, kind: 'member_left', member: action.member })
			break
		case 'chat_renamed': {
			const oldTitle = draft.chatTitle ?? null
			draft.nodes.push({ ...base, kind: 'chat_renamed', newTitle: action.newTitle, oldTitle })
			draft.chatTitle = action.newTitle
			break
		}
		case 'chat_photo_changed':
			draft.nodes.push({ ...base, kind: 'chat_photo_changed' })
			break
		case 'chat_photo_deleted':
			draft.nodes.push({ ...base, kind: 'chat_photo_deleted' })
			break
		case 'message_pinned': {
			const targetIdx = findMessageIndex(draft.nodes, action.messageId)
			let preview: string | undefined
			if (targetIdx !== -1) {
				const target = draft.nodes[targetIdx] as ICMessage
				const plain = contentToPlainText(target.content)
				if (plain)
					preview = truncate(plain, REPLY_PREVIEW_MAX)
			}
			draft.nodes.push({ ...base, kind: 'message_pinned', messageId: action.messageId, preview })
			break
		}
		case 'message_reaction':
			draft.nodes.push({
				...base,
				kind: 'message_reaction',
				messageId: action.messageId,
				operation: action.operation,
				reaction: action.reaction,
			})
			break
	}
}

function reduceRuntime(draft: IntermediateContext, event: RuntimeEvent) {
	const base = {
		receivedAtMs: event.receivedAtMs,
		timestampSec: event.timestampSec,
		type: 'runtime_event' as const,
		utcOffsetMin: event.utcOffsetMin,
	}
	switch (event.kind) {
		case 'schedule_triggered':
			draft.nodes.push({
				...base,
				instruction: event.instruction,
				kind: 'schedule_triggered',
				scheduleId: event.scheduleId,
				scheduleName: event.scheduleName,
			})
			break
		case 'task_completed':
			draft.nodes.push({
				...base,
				finalSummary: event.finalSummary,
				hasFullOutput: event.hasFullOutput,
				intention: event.intention,
				kind: 'task_completed',
				taskId: event.taskId,
				taskType: event.taskType,
			})
			break
	}
}

export function reduce(ic: IntermediateContext, event: PipelineEvent): IntermediateContext {
	return produce(ic, (draft) => {
		switch (event.type) {
			case 'message':
				reduceMessage(draft, event)
				break
			case 'edit':
				reduceEdit(draft, event)
				break
			case 'delete':
				reduceDelete(draft, event)
				break
			case 'service':
				reduceService(draft, event)
				break
			case 'runtime':
				reduceRuntime(draft, event)
				break
		}
	})
}
