export interface CanonicalUser {
	displayName: string
	id: string
	isBot: boolean
	username?: string
}

export interface CanonicalAttachment {
	altText?: string
	animationHash?: string
	duration?: number
	fileName?: string
	height?: number
	mimeType?: string
	platformFileId?: string
	stickerSetId?: string
	stickerSetName?: string
	thumbnailWebp?: string
	type: 'animation' | 'audio' | 'document' | 'photo' | 'sticker' | 'video' | 'video_note' | 'voice'
	width?: number
}

// Rich text content tree — platform-agnostic representation parsed from
// platform-specific encodings (e.g. Slack mrkdwn). Rendering serializes the tree.
export type ContentNode
	= | { altText?: string, altTextError?: string, children: ContentNode[], customEmojiId: string, stickerSetName?: string, type: 'custom_emoji' }
		| { children: ContentNode[], type: 'blockquote' }
		| { children: ContentNode[], type: 'bold' }
		| { children: ContentNode[], type: 'italic' }
		| { children: ContentNode[], type: 'link', url: string }
		| { children: ContentNode[], type: 'mention', userId?: string }
		| { children: ContentNode[], type: 'spoiler' }
		| { children: ContentNode[], type: 'strikethrough' }
		| { children: ContentNode[], type: 'underline' }
		| { language?: string, text: string, type: 'pre' }
		| { text: string, type: 'code' }
		| { text: string, type: 'text' }

export interface CanonicalForwardInfo {
	date?: number
	fromChatId?: string
	fromUserId?: string
	sender?: CanonicalUser
	senderName?: string
}

export interface CanonicalMessageEvent {
	attachments: CanonicalAttachment[]
	chatId: string
	content: ContentNode[]
	forwardInfo?: CanonicalForwardInfo
	isSelfSent?: boolean
	messageId: string
	receivedAtMs: number
	replyToMessageId?: string
	sender?: CanonicalUser
	timestampSec: number
	type: 'message'
	utcOffsetMin: number
}

export interface CanonicalEditEvent {
	attachments: CanonicalAttachment[]
	chatId: string
	content: ContentNode[]
	messageId: string
	receivedAtMs: number
	sender?: CanonicalUser
	timestampSec: number
	type: 'edit'
	utcOffsetMin: number
}

export interface CanonicalDeleteEvent {
	chatId: string
	messageIds: string[]
	receivedAtMs: number
	timestampSec: number
	type: 'delete'
	utcOffsetMin: number
}

// --- Service events (group lifecycle) ---

export interface ServiceActionMembersJoined { action: 'members_joined', members: CanonicalUser[] }
export interface ServiceActionMemberLeft { action: 'member_left', member: CanonicalUser }
export interface ServiceActionChatRenamed { action: 'chat_renamed', newTitle: string }
export interface ServiceActionChatPhotoChanged { action: 'chat_photo_changed' }
export interface ServiceActionChatPhotoDeleted { action: 'chat_photo_deleted' }
export interface ServiceActionMessagePinned { action: 'message_pinned', messageId: string }
export interface ServiceActionMessageReaction { action: 'message_reaction', messageId: string, operation: 'added' | 'removed', reaction: string }

export type ServiceAction
	= | ServiceActionChatPhotoChanged
		| ServiceActionChatPhotoDeleted
		| ServiceActionChatRenamed
		| ServiceActionMemberLeft
		| ServiceActionMembersJoined
		| ServiceActionMessagePinned
		| ServiceActionMessageReaction

export interface CanonicalServiceEvent {
	action: ServiceAction
	actor?: CanonicalUser
	chatId: string
	receivedAtMs: number
	timestampSec: number
	type: 'service'
	utcOffsetMin: number
}

export type CanonicalIMEvent
	= | CanonicalDeleteEvent
		| CanonicalEditEvent
		| CanonicalMessageEvent
		| CanonicalServiceEvent
