import type { Logger } from '@guiiai/logg'
import type { WebClient } from '@slack/web-api'

import type { ImageToTextResolver } from '../media/image-to-text'
import type { SlackEmojiCache } from './emoji-catalog'
import type {
	SlackCanvasLookupOptions,
	SlackEmojiListOptions,
	SlackFileAttachment,
	SlackMessage,
	SlackMessageDelete,
	SlackMessageEdit,
	SlackReactionEvent,
	SlackSentMessage,
	SlackThreadReply,
	SlackUser,
} from './types'

import { Buffer } from 'node:buffer'

import { App, LogLevel } from '@slack/bolt'

import { createEventBus } from '../event-bus'
import { registerHttpSecret } from '../http'
import { generateThumbnail } from '../media/thumbnail'
import { catalogViewFromCache, loadSlackEmojiCache, renderSlackEmojiCatalogXml } from './emoji-catalog'
import { markdownToMrkdwn } from './markdown-to-mrkdwn'

export interface SlackManagerOptions {
	appToken: string
	botToken: string
	botUserId?: string
	imageToText?: ImageToTextResolver
	imageToTextChatIds?: Set<string>
	signingSecret?: string
}

export interface SlackUploadItem {
	buffer: Buffer
	fileName?: string
	title?: string
}

export interface SlackManager {
	addReaction: (channel: string, messageTs: string, reaction: string) => Promise<void>
	botUserId: () => string | undefined
	client: WebClient
	deleteMessage: (channel: string, messageTs: string) => Promise<void>
	downloadFileById: (fileId: string) => Promise<Buffer | undefined>
	emojiCatalogXml: () => string | undefined
	init: () => Promise<void>
	listEmoji: (options?: SlackEmojiListOptions) => Promise<unknown>
	onMessage: (handler: (msg: SlackMessage) => void) => void
	onMessageDelete: (handler: (del: SlackMessageDelete) => void) => void
	onMessageEdit: (handler: (edit: SlackMessageEdit) => void) => void
	onReaction: (handler: (reaction: SlackReactionEvent) => void) => void
	readCanvas: (options: SlackCanvasLookupOptions) => Promise<unknown>
	readChannelInfo: (channel: string) => Promise<unknown>
	readChannelMembers: (channel: string, limit?: number) => Promise<unknown>
	readThread: (channel: string, threadTs: string, limit?: number) => Promise<SlackThreadReply[]>
	readUserProfile: (userId: string) => Promise<unknown>
	removeReaction: (channel: string, messageTs: string, reaction: string) => Promise<void>
	sendMessage: (channel: string, text: string, threadTs?: string) => Promise<SlackSentMessage>
	start: () => Promise<void>
	stop: () => Promise<void>
	updateMessage: (channel: string, messageTs: string, text: string) => Promise<SlackSentMessage>
	uploadFiles: (channel: string, files: SlackUploadItem[], initialComment?: string, threadTs?: string) => Promise<SlackSentMessage>
}

function captureIngressMeta() {
	return {
		receivedAtMs: Date.now(),
		utcOffsetMin: -new Date().getTimezoneOffset(),
	}
}

const slackTsToSec = (ts: string): number => Math.floor(Number.parseFloat(ts))

const userCacheKey = (teamId: string | undefined, userId: string) => `${teamId ?? ''}:${userId}`

function stripSlackPrefix(id: string): string {
	return id.startsWith('slack:') ? id.slice('slack:'.length) : id
}

function isImageFile(file: SlackFileAttachment): boolean {
	return (file.mimeType?.startsWith('image/') ?? false)
		&& file.mimeType !== 'image/svg+xml'
}

export function createSlackManager(options: SlackManagerOptions, logger: Logger): SlackManager {
	const log = logger.withContext('slack')
	registerHttpSecret(options.botToken)
	registerHttpSecret(options.appToken)
	if (options.signingSecret)
		registerHttpSecret(options.signingSecret)

	const app = new App({
		appToken: options.appToken,
		logLevel: LogLevel.WARN,
		signingSecret: options.signingSecret ?? 'socket-mode',
		socketMode: true,
		token: options.botToken,
	})

	const messageBus = createEventBus<SlackMessage>('slack:message', logger)
	const editBus = createEventBus<SlackMessageEdit>('slack:edit', logger)
	const deleteBus = createEventBus<SlackMessageDelete>('slack:delete', logger)
	const reactionBus = createEventBus<SlackReactionEvent>('slack:reaction', logger)
	const userCache = new Map<string, SlackUser>()
	const seenMessages: string[] = []
	const seenMessageSet = new Set<string>()
	let botUserId = options.botUserId
	let emojiCache: SlackEmojiCache | undefined
	let running = false

	const loadEmoji = async (includeStandard = true): Promise<SlackEmojiCache> => {
		emojiCache = await loadSlackEmojiCache(app.client, log, includeStandard, emojiCache)
		return emojiCache
	}

	const toFileAttachment = (file: any): SlackFileAttachment | undefined => {
		const id = file?.id
		if (!id)
			return undefined
		return {
			duration: file.duration_ms != null ? Math.round(file.duration_ms / 1000) : undefined,
			fileType: file.filetype,
			height: file.original_h ?? file.height ?? file.thumb_360_h,
			id,
			mimeType: file.mimetype,
			name: file.name,
			size: file.size,
			title: file.title,
			urlPrivate: file.url_private_download ?? file.url_private,
			width: file.original_w ?? file.width ?? file.thumb_360_w,
		}
	}

	const downloadFile = async (file: SlackFileAttachment): Promise<Buffer | undefined> => {
		if (!file.urlPrivate)
			return undefined
		const res = await fetch(file.urlPrivate, {
			headers: { Authorization: `Bearer ${options.botToken}` },
		})
		if (!res.ok)
			throw new Error(`Slack file download failed (${res.status} ${res.statusText})`)
		return Buffer.from(await res.arrayBuffer())
	}

	const downloadFileById = async (fileId: string): Promise<Buffer | undefined> => {
		const info = await app.client.files.info({ file: fileId })
		const file = toFileAttachment(info.file)
		return file ? await downloadFile(file) : undefined
	}

	const hydrateFiles = async (chatId: string, text: string, files?: SlackFileAttachment[]) => {
		if (!files || files.length === 0)
			return

		const originalBuffers = new Map<SlackFileAttachment, Buffer>()
		await Promise.all(files.map(async (file) => {
			if (file.thumbnailWebp || !isImageFile(file))
				return
			try {
				const buffer = await downloadFile(file)
				if (!buffer)
					return
				originalBuffers.set(file, buffer)
				file.thumbnailWebp = await generateThumbnail(buffer)
			}
			catch (err) {
				log.withError(err).withFields({ chatId, fileId: file.id }).warn('Failed to generate Slack file thumbnail')
			}
		}))

		if (options.imageToText && (!options.imageToTextChatIds || options.imageToTextChatIds.has(chatId))) {
			await Promise.all(files.map(async (file) => {
				if (!file.thumbnailWebp)
					return
				const thumbnailBuffer = Buffer.from(file.thumbnailWebp, 'base64')
				await options.imageToText!.resolve(thumbnailBuffer, text, originalBuffers.get(file))
			}))
		}
	}

	const loadUser = async (userId?: string, teamId?: string): Promise<SlackUser | undefined> => {
		if (!userId)
			return undefined
		const key = userCacheKey(teamId, userId)
		const cached = userCache.get(key)
		if (cached)
			return cached

		try {
			const result = await app.client.users.info({ user: userId })
			const user = result.user
			const profile = user?.profile
			const displayName = profile?.display_name && profile.display_name !== ''
				? profile.display_name
				: (profile?.real_name && profile.real_name !== ''
						? profile.real_name
						: (user?.real_name && user.real_name !== '' ? user.real_name : (user?.name ?? userId)))
			const mapped: SlackUser = {
				displayName,
				id: userId,
				isBot: user?.is_bot ?? false,
				username: user?.name,
			}
			userCache.set(key, mapped)
			return mapped
		}
		catch (err) {
			log.withError(err).withFields({ userId }).warn('Failed to load Slack user profile')
			return { displayName: userId, id: userId, isBot: false }
		}
	}

	const toMessage = async (event: any): Promise<SlackMessage | undefined> => {
		if (!event.channel || !event.ts || event.bot_id)
			return undefined
		if (event.subtype && event.subtype !== 'file_share')
			return undefined
		const sender = await loadUser(event.user, event.team)
		const files = Array.isArray(event.files)
			? event.files.map(toFileAttachment).filter((file: SlackFileAttachment | undefined): file is SlackFileAttachment => file != null)
			: undefined
		const msg: SlackMessage = {
			chatId: event.channel,
			date: slackTsToSec(event.ts),
			files,
			messageId: event.ts,
			replyToMessageId: event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined,
			sender,
			text: event.text ?? '',
			...captureIngressMeta(),
		}
		await hydrateFiles(msg.chatId, msg.text, msg.files)
		return msg
	}

	const emitMessage = (msg: SlackMessage) => {
		const key = `${msg.chatId}:${msg.messageId}`
		if (seenMessageSet.has(key))
			return
		seenMessageSet.add(key)
		seenMessages.push(key)
		if (seenMessages.length > 10_000) {
			const evicted = seenMessages.shift()
			if (evicted)
				seenMessageSet.delete(evicted)
		}
		messageBus.emit(msg)
	}

	app.event('message', async ({ event }) => {
		const messageEvent = event as any
		try {
			if (messageEvent.subtype === 'message_changed') {
				const changed = messageEvent.message
				if (!changed?.channel || !changed?.ts || changed.bot_id)
					return
				const sender = await loadUser(changed.user, changed.team ?? messageEvent.team)
				const files = Array.isArray(changed.files)
					? changed.files.map(toFileAttachment).filter((file: SlackFileAttachment | undefined): file is SlackFileAttachment => file != null)
					: undefined
				await hydrateFiles(changed.channel, changed.text ?? '', files)
				editBus.emit({
					chatId: changed.channel,
					date: slackTsToSec(changed.ts),
					editDate: messageEvent.event_ts ? slackTsToSec(messageEvent.event_ts) : Math.floor(Date.now() / 1000),
					files,
					messageId: changed.ts,
					sender,
					text: changed.text ?? '',
					...captureIngressMeta(),
				})
				return
			}

			if (messageEvent.subtype === 'message_deleted') {
				if (!messageEvent.channel || !messageEvent.deleted_ts)
					return
				deleteBus.emit({
					chatId: messageEvent.channel,
					messageIds: [messageEvent.deleted_ts],
					...captureIngressMeta(),
				})
				return
			}

			const msg = await toMessage(messageEvent)
			if (msg)
				emitMessage(msg)
		}
		catch (err) {
			log.withError(err).error('Failed to handle Slack message event')
		}
	})

	app.event('app_mention', async ({ event }) => {
		try {
			const msg = await toMessage(event)
			if (msg)
				emitMessage(msg)
		}
		catch (err) {
			log.withError(err).error('Failed to handle Slack app_mention event')
		}
	})

	app.event('reaction_added', async ({ event }) => {
		const reactionEvent = event as any
		try {
			const item = reactionEvent.item
			if (item?.type !== 'message' || !item.channel || !item.ts)
				return
			reactionBus.emit({
				chatId: item.channel,
				messageId: item.ts,
				operation: 'added',
				reaction: reactionEvent.reaction,
				sender: await loadUser(reactionEvent.user, reactionEvent.team),
				...captureIngressMeta(),
			})
		}
		catch (err) {
			log.withError(err).error('Failed to handle Slack reaction_added event')
		}
	})

	app.event('reaction_removed', async ({ event }) => {
		const reactionEvent = event as any
		try {
			const item = reactionEvent.item
			if (item?.type !== 'message' || !item.channel || !item.ts)
				return
			reactionBus.emit({
				chatId: item.channel,
				messageId: item.ts,
				operation: 'removed',
				reaction: reactionEvent.reaction,
				sender: await loadUser(reactionEvent.user, reactionEvent.team),
				...captureIngressMeta(),
			})
		}
		catch (err) {
			log.withError(err).error('Failed to handle Slack reaction_removed event')
		}
	})

	app.event('emoji_changed', async () => {
		emojiCache = undefined
	})

	app.error(async (err) => {
		log.withError(err).error('Slack app error')
	})

	const init = async () => {
		if (!botUserId) {
			const auth = await app.client.auth.test()
			botUserId = auth.user_id
			log.withFields({ botUserId, team: auth.team }).log('Slack authenticated')
		}
		const cache = await loadEmoji(true)
		const view = catalogViewFromCache(cache)
		log.withFields({
			customEmoji: view.totalCustom,
			loadError: view.loadError ?? null,
			truncated: view.truncated,
		}).log('Slack emoji cache loaded')
	}

	const start = async () => {
		await init()
		if (running)
			return
		await app.start()
		running = true
		log.log('Slack Socket Mode started')
	}

	const stop = async () => {
		if (!running)
			return
		await app.stop()
		running = false
		log.log('Slack stopped')
	}

	const sendMessage = async (channel: string, text: string, threadTs?: string): Promise<SlackSentMessage> => {
		const mrkdwnText = markdownToMrkdwn(text)
		const sent = await app.client.chat.postMessage({
			channel,
			mrkdwn: true,
			text: mrkdwnText,
			thread_ts: threadTs,
		})
		const ts = sent.ts ?? sent.message?.ts
		if (!ts)
			throw new Error('Slack did not return a message timestamp')
		return {
			date: slackTsToSec(ts),
			messageId: ts,
			text: sent.message?.text ?? text,
		}
	}

	const uploadFiles = async (
		channel: string,
		files: SlackUploadItem[],
		initialComment?: string,
		threadTs?: string,
	): Promise<SlackSentMessage> => {
		if (files.length === 0)
			return await sendMessage(channel, initialComment ?? '', threadTs)
		const mrkdwnComment = initialComment ? markdownToMrkdwn(initialComment) : undefined
		await app.client.filesUploadV2({
			channel_id: channel,
			file_uploads: files.map(file => ({
				file: file.buffer,
				filename: file.fileName,
				title: file.title ?? file.fileName,
			})),
			initial_comment: mrkdwnComment,
			thread_ts: threadTs,
		})
		const fallback = mrkdwnComment && mrkdwnComment !== ''
			? mrkdwnComment
			: files.map(file => file.fileName ?? 'attachment').join(', ')
		return {
			date: Math.floor(Date.now() / 1000),
			messageId: String(Date.now() / 1000),
			text: fallback,
		}
	}

	const normalizeReactionName = (reaction: string): string =>
		reaction.replace(/^:|:$/g, '')

	const addReaction = async (channel: string, messageTs: string, reaction: string): Promise<void> => {
		await app.client.reactions.add({ channel, name: normalizeReactionName(reaction), timestamp: messageTs })
	}

	const removeReaction = async (channel: string, messageTs: string, reaction: string): Promise<void> => {
		await app.client.reactions.remove({ channel, name: normalizeReactionName(reaction), timestamp: messageTs })
	}

	const updateMessage = async (channel: string, messageTs: string, text: string): Promise<SlackSentMessage> => {
		const mrkdwnText = markdownToMrkdwn(text)
		const updated = await app.client.chat.update({
			channel,
			text: mrkdwnText,
			ts: messageTs,
		})
		const ts = updated.ts ?? messageTs
		return {
			date: slackTsToSec(ts),
			messageId: ts,
			text: updated.message?.text ?? text,
		}
	}

	const deleteMessage = async (channel: string, messageTs: string): Promise<void> => {
		await app.client.chat.delete({ channel, ts: messageTs })
	}

	const readThread = async (channel: string, threadTs: string, limit = 20): Promise<SlackThreadReply[]> => {
		const result = await app.client.conversations.replies({
			channel,
			limit: Math.min(Math.max(limit, 1), 100),
			ts: threadTs,
		})
		const messages = result.messages ?? []
		return await Promise.all(messages.map(async msg => ({
			date: msg.ts ? slackTsToSec(msg.ts) : 0,
			messageId: msg.ts ?? '',
			sender: await loadUser(msg.user, msg.team),
			text: msg.text ?? '',
		})))
	}

	const readChannelInfo = async (chatId: string): Promise<unknown> => {
		const channel = stripSlackPrefix(chatId)
		const result = await app.client.conversations.info({ channel, include_num_members: true })
		return result.channel ?? result
	}

	const readChannelMembers = async (chatId: string, limit = 200): Promise<unknown> => {
		const channel = stripSlackPrefix(chatId)
		const members: string[] = []
		let cursor: string | undefined
		do {
			const result = await app.client.conversations.members({
				channel,
				limit: Math.min(1000, Math.max(1, limit - members.length)),
				...(cursor ? { cursor } : {}),
			})
			members.push(...(result.members ?? []))
			cursor = result.response_metadata?.next_cursor
		} while (cursor && members.length < limit)

		return { channel, members, truncated: !!cursor && members.length >= limit }
	}

	const readUserProfile = async (userId: string): Promise<unknown> => {
		const user = stripSlackPrefix(userId)
		const [info, profile] = await Promise.all([
			app.client.users.info({ user }),
			app.client.users.profile.get({ include_labels: true, user }),
		])
		return { info: info.user, profile: profile.profile }
	}

	const listEmoji = async (opts: SlackEmojiListOptions = {}): Promise<unknown> => {
		const emoji = await loadEmoji(opts.includeStandard ?? true)
		const query = opts.query?.toLowerCase()
		const includeUrls = opts.includeUrls ?? false
		const limit = opts.limit ?? 500
		const filtered = Object.entries(emoji.data)
			.filter(([name]) => !query || name.toLowerCase().includes(query))
		const entries = filtered
			.slice(0, limit <= 0 ? undefined : limit)
			.map(([name, url]) => includeUrls ? { name, url } : name)

		return {
			cacheAgeMs: Date.now() - emoji.fetchedAt,
			categories: opts.includeStandard === false ? undefined : emoji.categories,
			emoji: entries,
			returned: entries.length,
			totalCustomEmoji: Object.keys(emoji.data).length,
			truncated: limit > 0 && entries.length < filtered.length,
		}
	}

	const readCanvas = async (opts: SlackCanvasLookupOptions): Promise<unknown> => {
		const sectionTypes = opts.sectionTypes && opts.sectionTypes.length > 0
			? opts.sectionTypes
			: ['any_header' as const]
		const criteria: Record<string, unknown> = {}
		if (opts.containsText)
			criteria.contains_text = opts.containsText
		if (sectionTypes.length > 0)
			criteria.section_types = sectionTypes.slice(0, 3)

		return await app.client.canvases.sections.lookup({
			canvas_id: opts.canvasId,
			criteria: criteria as unknown as Parameters<typeof app.client.canvases.sections.lookup>[0]['criteria'],
		})
	}

	return {
		addReaction,
		botUserId: () => botUserId,
		client: app.client,
		deleteMessage,
		downloadFileById,
		emojiCatalogXml: () => emojiCache ? renderSlackEmojiCatalogXml(catalogViewFromCache(emojiCache)) : undefined,
		init,
		listEmoji,
		onMessage: messageBus.on,
		onMessageDelete: deleteBus.on,
		onMessageEdit: editBus.on,
		onReaction: reactionBus.on,
		readCanvas,
		readChannelInfo,
		readChannelMembers,
		readThread,
		readUserProfile,
		removeReaction,
		sendMessage,
		start,
		stop,
		updateMessage,
		uploadFiles,
	}
}

export type {
	SlackCanvasLookupOptions,
	SlackEmojiListOptions,
	SlackMessage,
	SlackMessageDelete,
	SlackMessageEdit,
	SlackReactionEvent,
	SlackSentMessage,
	SlackThreadReply,
}
