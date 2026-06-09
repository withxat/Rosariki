import type { CanonicalAttachment, CanonicalForwardInfo, CanonicalUser, ContentNode } from '../adaptation/types'

export interface ICMessage {
	attachments: CanonicalAttachment[]
	content: ContentNode[]
	deleted?: boolean
	editedAtSec?: number
	editUtcOffsetMin?: number
	forwardInfo?: CanonicalForwardInfo
	isSelfSent?: boolean
	messageId: string
	receivedAtMs: number
	replyToContent?: ContentNode[]
	replyToMessageId?: string
	replyToPreview?: string
	replyToSender?: CanonicalUser
	sender?: CanonicalUser
	timestampSec: number
	type: 'message'
	utcOffsetMin: number
}

export interface ICUserRenamedEvent {
	kind: 'user_renamed'
	newUser: CanonicalUser
	oldUser: CanonicalUser
	receivedAtMs: number
	timestampSec: number
	type: 'system_event'
	userId: string
	utcOffsetMin: number
}

export interface ICMembersJoinedEvent {
	actor?: CanonicalUser
	kind: 'members_joined'
	members: CanonicalUser[]
	receivedAtMs: number
	timestampSec: number
	type: 'system_event'
	utcOffsetMin: number
}

export interface ICMemberLeftEvent {
	actor?: CanonicalUser
	kind: 'member_left'
	member: CanonicalUser
	receivedAtMs: number
	timestampSec: number
	type: 'system_event'
	utcOffsetMin: number
}

export interface ICChatRenamedEvent {
	actor?: CanonicalUser
	kind: 'chat_renamed'
	newTitle: string
	oldTitle: null | string
	receivedAtMs: number
	timestampSec: number
	type: 'system_event'
	utcOffsetMin: number
}

export interface ICChatPhotoChangedEvent {
	actor?: CanonicalUser
	kind: 'chat_photo_changed'
	receivedAtMs: number
	timestampSec: number
	type: 'system_event'
	utcOffsetMin: number
}

export interface ICChatPhotoDeletedEvent {
	actor?: CanonicalUser
	kind: 'chat_photo_deleted'
	receivedAtMs: number
	timestampSec: number
	type: 'system_event'
	utcOffsetMin: number
}

export interface ICMessagePinnedEvent {
	actor?: CanonicalUser
	kind: 'message_pinned'
	messageId: string
	preview?: string
	receivedAtMs: number
	timestampSec: number
	type: 'system_event'
	utcOffsetMin: number
}

export interface ICMessageReactionEvent {
	actor?: CanonicalUser
	kind: 'message_reaction'
	messageId: string
	operation: 'added' | 'removed'
	reaction: string
	receivedAtMs: number
	timestampSec: number
	type: 'system_event'
	utcOffsetMin: number
}

export type ICSystemEvent
	= | ICChatPhotoChangedEvent
		| ICChatPhotoDeletedEvent
		| ICChatRenamedEvent
		| ICMemberLeftEvent
		| ICMembersJoinedEvent
		| ICMessagePinnedEvent
		| ICMessageReactionEvent
		| ICUserRenamedEvent

export interface ICRuntimeTaskCompleted {
	finalSummary: string
	hasFullOutput: boolean
	intention?: string
	kind: 'task_completed'
	receivedAtMs: number
	taskId: number
	taskType: string
	timestampSec: number
	type: 'runtime_event'
	utcOffsetMin: number
}

export interface ICRuntimeScheduleTriggered {
	instruction: string
	kind: 'schedule_triggered'
	receivedAtMs: number
	scheduleId: number
	scheduleName?: string
	timestampSec: number
	type: 'runtime_event'
	utcOffsetMin: number
}

export type ICRuntimeEvent = ICRuntimeScheduleTriggered | ICRuntimeTaskCompleted

export type ICNode = ICMessage | ICRuntimeEvent | ICSystemEvent

export interface ICUserState {
	firstSeenAtMs: number
	lastSeenAtMs: number
	messageCount: number
	user: CanonicalUser
}

export interface IntermediateContext {
	chatTitle?: string
	nodes: ICNode[]
	sessionId: string
	users: Map<string, ICUserState>
}

export function createEmptyIC(sessionId: string): IntermediateContext {
	return {
		nodes: [],
		sessionId,
		users: new Map(),
	}
}
