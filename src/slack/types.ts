export interface SlackUser {
	displayName: string
	id: string
	isBot: boolean
	username?: string
}

export interface SlackFileAttachment {
	duration?: number
	fileType?: string
	height?: number
	id: string
	mimeType?: string
	name?: string
	size?: number
	thumbnailWebp?: string
	title?: string
	urlPrivate?: string
	width?: number
}

export interface SlackMessage {
	chatId: string
	date: number
	files?: SlackFileAttachment[]
	messageId: string
	receivedAtMs?: number
	replyToMessageId?: string
	sender?: SlackUser
	text: string
	utcOffsetMin?: number
}

export interface SlackMessageEdit {
	chatId: string
	date: number
	editDate: number
	files?: SlackFileAttachment[]
	messageId: string
	receivedAtMs?: number
	sender?: SlackUser
	text: string
	utcOffsetMin?: number
}

export interface SlackMessageDelete {
	chatId: string
	messageIds: string[]
	receivedAtMs?: number
	utcOffsetMin?: number
}

export interface SlackReactionEvent {
	chatId: string
	messageId: string
	operation: 'added' | 'removed'
	reaction: string
	receivedAtMs?: number
	sender?: SlackUser
	utcOffsetMin?: number
}

export interface SlackSentMessage {
	date: number
	messageId: string
	text: string
}

export interface SlackThreadReply {
	date: number
	messageId: string
	sender?: SlackUser
	text: string
}

export interface SlackEmojiListOptions {
	includeStandard?: boolean
	includeUrls?: boolean
	limit?: number
	query?: string
}

export interface SlackCanvasLookupOptions {
	canvasId: string
	containsText?: string
	sectionTypes?: Array<'any_header' | 'h1' | 'h2' | 'h3'>
}
