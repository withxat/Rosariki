import type { Buffer } from 'node:buffer'

import type { Logger } from '@guiiai/logg'

import type { CanonicalAttachment } from '../adaptation/types'
import type { ActiveTaskInfo } from '../background-task/types'
import type { RuntimeConfig } from '../config/config'
import type { RenderedContext } from '../rendering/types'
import type { ToolSchema } from './call-llm'
import type { ScheduledTaskToolDeps } from './scheduled-task-tools'
import type { CahciuaTool, ChatInteractionDeps, SendMessageAttachment } from './tools'
import type { CompactionSessionMeta, DriverConfig, LlmEndpoint, ProbeResponseV2, TurnResponseV2 } from './types'

import { computed, effect, signal } from 'alien-signals'

import { renderImageToTextSystemPrompt } from '../media/image-to-text-prompt'
import { callDescriptionLlm } from '../media/llm-description'
import { callLlm } from './call-llm'
import { runCompaction } from './compaction'
import { composeContext, findWorkingWindowCursor, injectLateBindingPrompt, latestExternalEventMs, wasToolLoopInterrupted } from './context'
import { renderLateBindingPrompt, renderSystemPrompt } from './prompt'
import { createReactionGuardRegistry } from './reaction-guard'
import { createRunner } from './runner'
import { createCancelScheduleTool, createListSchedulesTool, createScheduleTool } from './scheduled-task-tools'
import { collectRecentSendMessageAssessments, renderRecentSendMessageHumanLikenessXml } from './send-message-human-likeness'
import { computeSlackReplyPlacement, renderSlackReplyPlacementXml } from './slack-reply-placement'
import {
	createAttachmentDownloader,
	createBashTool,
	createChatInteractionTools,
	createDownloadFileTool,
	createKillTaskTool,
	createReadImageTool,
	createReadTaskOutputTool,
	createSendMessageTool,
	createSlackListEmojiTool,
	createSlackReadCanvasTool,
	createSlackReadChannelInfoTool,
	createSlackReadChannelMembersTool,
	createSlackReadUserProfileTool,
	createWebSearchTool,
} from './tools'

/** Format current time in local timezone as ISO 8601 with offset (e.g. 2025-03-13T22:30:00+08:00). */
function localTimeNow(): string {
	const now = new Date()
	const off = -now.getTimezoneOffset()
	const sign = off >= 0 ? '+' : '-'
	const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
	const tz = `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
	const iso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
	return `${iso}${tz}`
}

export { mergeContext } from './merge'
export { renderLateBindingPrompt, renderSystemPrompt } from './prompt'
export type { DriverConfig, ProviderFormat } from './types'
export type { ProbeResponseV2, TurnResponseV2 } from './types'

const MAX_STEPS = Infinity

function toToolSchema(t: CahciuaTool): ToolSchema {
	return {
		name: t.function.name,
		parameters: t.function.parameters,
		...(t.function.description ? { description: t.function.description } : {}),
	}
}

export function createDriver(config: DriverConfig, deps: {
	backgroundTask: {
		getActiveTasks: (sessionId: string) => ActiveTaskInfo[]
		killTask: (taskId: number) => { error?: string, ok: boolean }
		readTaskOutput: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string, totalLines: number, truncated: boolean } | { error: string }>
		startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number
	}
	chatInteractions?: (chatId: string) => ChatInteractionDeps | undefined
	downloadPlatformFile: (platformFileId: string) => Promise<Buffer | undefined>
	getChatTitle: (chatId: string) => string | undefined
	getSlackEmojiCatalogXml?: () => string | undefined
	loadCompaction: (chatId: string) => CompactionSessionMeta | null
	loadLastProbeTime: (chatId: string) => number
	loadMessageAttachments: (chatId: string, messageId: string) => CanonicalAttachment[] | undefined
	loadTurnResponses: (chatId: string, afterMs?: number) => Promise<TurnResponseV2[]>
	logger: Logger
	lookupMessageSenderId?: (chatId: string, messageId: string) => string | undefined
	persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void
	persistProbeResponse: (chatId: string, probe: ProbeResponseV2) => Promise<void>
	persistTurnResponse: (chatId: string, tr: TurnResponseV2) => Promise<void>
	resolveModel: (name: string) => LlmEndpoint
	runtimeConfig: RuntimeConfig
	schedule?: (chatId: string) => ScheduledTaskToolDeps
	sendMessage: (chatId: string, text: string, replyToMessageId?: string, attachments?: SendMessageAttachment[]) => Promise<{ date: number, messageId: number | string }>
	setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext | undefined
	slack?: {
		listEmoji: (opts: { includeStandard?: boolean, includeUrls?: boolean, limit?: number, query?: string }) => Promise<unknown>
		readCanvas: (opts: { canvasId: string, containsText?: string, sectionTypes?: Array<'any_header' | 'h1' | 'h2' | 'h3'> }) => Promise<unknown>
		readChannelInfo: (chatId: string) => Promise<unknown>
		readChannelMembers: (chatId: string, limit?: number) => Promise<unknown>
		readUserProfile: (userId: string) => Promise<unknown>
	}
	systemFiles?: { content: string, filename: string }[]
}) {
	const { logger } = deps
	const log = logger.withContext('driver')
	const chatIds = new Set(config.chatIds)
	const reactionGuards = createReactionGuardRegistry()

	// Runner cache: keyed by "apiBaseUrl::model" to reuse runners across chats
	// sharing the same endpoint.
	const runners = new Map<string, ReturnType<typeof createRunner>>()
	const getOrCreateRunner = (endpoint: LlmEndpoint) => {
		const key = `${endpoint.apiFormat ?? 'openai-chat'}::${endpoint.apiBaseUrl}::${endpoint.model}`
		let runner = runners.get(key)
		if (!runner) {
			runner = createRunner({
				apiBaseUrl: endpoint.apiBaseUrl,
				apiFormat: endpoint.apiFormat ?? 'openai-chat',
				apiKey: endpoint.apiKey,
				authPath: endpoint.authPath,
				forceToolCall: endpoint.forceToolCall,
				model: endpoint.model,
				timeoutSec: endpoint.timeoutSec,
			})
			runners.set(key, runner)
		}
		return runner
	}

	const loadTRs = (chatId: string, afterMs?: number): Promise<TurnResponseV2[]> =>
		deps.loadTurnResponses(chatId, afterMs)

	const getLastProcessedTime = async (chatId: string): Promise<number> => {
		const trs = await deps.loadTurnResponses(chatId)
		const lastTr = trs.length > 0 ? trs[trs.length - 1]!.requestedAtMs : 0
		const lastProbe = deps.loadLastProbeTime(chatId)
		return Math.max(lastTr, lastProbe)
	}

	const chatScopes = new Map<string, {
		cleanup: () => void
		rc: ReturnType<typeof signal<RenderedContext>>
	}>()

	const getOrCreateScope = (chatId: string) => {
		const existing = chatScopes.get(chatId)
		if (existing)
			return existing

		// Resolve per-chat config once per scope
		const chatConfig = config.resolveChatConfig(chatId)

		const rc = signal<RenderedContext>([])
		const lastProcessedMs = signal(0)
		void getLastProcessedTime(chatId).then(v => lastProcessedMs(Math.max(lastProcessedMs(), v)))
		const running = signal(false)
		const failedRc = signal<null | RenderedContext>(null)
		let timer: ReturnType<typeof setTimeout> | undefined

		// --- Compaction state as signal ---
		// Initialized from DB on scope creation (cold start). Updated by the
		// compaction effect when it completes. Read by the reply effect to
		// get cursor + summary. No runtime DB queries.
		const compactionMeta = signal<CompactionSessionMeta | null>(
			deps.loadCompaction(chatId),
		)

		// Derived values for convenience
		const cursorMs = computed(() => compactionMeta()?.newCursorMs)
		const summary = computed(() => compactionMeta()?.summary)

		// --- Auto-apply cursor to pipeline when compaction state changes ---
		// When compactionMeta updates (from cold start init or compaction completion),
		// tell the pipeline to re-render RC excluding nodes before the cursor.
		const disposeCursorEffect = effect(() => {
			const cursor = cursorMs()
			if (cursor == null)
				return
			const newRC = deps.setCompactCursor(chatId, cursor)
			if (newRC)
				rc(newRC)
		})

		// --- Main LLM reply effect ---
		// Triggers immediately when new external messages arrive (no debounce).
		// Natural batching: `running` prevents concurrent calls, so messages
		// arriving during an LLM call accumulate and get picked up on the next run.
		const needsReply = computed(() => {
			const rcVal = rc()
			if (rcVal.length === 0)
				return false
			if (rcVal === failedRc())
				return false
			return latestExternalEventMs(rcVal, lastProcessedMs()) != null
		})

		const disposeReplyEffect = effect(() => {
			const isRunning = running()
			if (timer) {
				clearTimeout(timer)
				timer = undefined
			}
			if (isRunning)
				return

			if (!needsReply())
				return

			// setTimeout(0) to exit the synchronous signal graph before starting async work
			timer = setTimeout(() => {
				const rcAtStart = rc()
				running(true)

				void (async () => {
					try {
						// Read compaction state from signal — no DB query.
						const cursor = cursorMs()
						const sum = summary()

						const trs = await loadTRs(chatId, cursor)
						const ctx = composeContext(rcAtStart, trs, chatConfig.compaction.maxContextEstTokens, chatConfig.primaryModel.model, sum)
						if (!ctx)
							return

						log.withFields({
							chatId,
							entries: ctx.entries.length,
							estimatedTokens: ctx.estimatedTokens,
						}).log('Triggering LLM call')

						const sendMessageTool = createSendMessageTool(async (text, replyTo, attachments) => {
							log.withFields({
								attachments: attachments?.length ?? 0,
								chatId,
								replyTo,
								text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
							}).log('send_message tool called')
							const sent = await deps.sendMessage(chatId, text, replyTo, attachments)
							return { messageId: String(sent.messageId) }
						})

						const downloadAttachment = createAttachmentDownloader({
							chatId,
							downloadPlatformFile: deps.downloadPlatformFile,
							loadMessageAttachments: deps.loadMessageAttachments,
						})

						const tools: CahciuaTool[] = [sendMessageTool]
						const chatInteractions = deps.chatInteractions?.(chatId)
						if (chatInteractions) {
							tools.push(...createChatInteractionTools({
								...chatInteractions,
								lookupSenderId: messageId => deps.lookupMessageSenderId?.(chatId, messageId),
								reactionGuard: reactionGuards.forChat(chatId),
							}))
						}
						tools.push(createBashTool(deps.runtimeConfig, {
							backgroundThresholdSec: chatConfig.tools.bash.backgroundThresholdSec,
							sessionId: chatId,
							startTask: deps.backgroundTask.startTask,
						}))
						tools.push(createWebSearchTool(chatConfig.tools.webSearch.tavilyKey))
						tools.push(createDownloadFileTool({
							downloadAttachment,
							runtime: deps.runtimeConfig,
						}))
						{
							const readFileCmd = deps.runtimeConfig.readFile
							const resolveImageToText = chatConfig.imageToText.enabled && chatConfig.imageToText.model
								? async (buffer: Buffer, detail: 'high' | 'low') => {
									const maxEdge = detail === 'high' ? 1024 : 512
									const { default: sharp } = await import('sharp')
									const resized = await sharp(buffer)
										.resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
										.png()
										.toBuffer()
									const imageUrl = `data:image/png;base64,${resized.toString('base64')}`
									const system = await renderImageToTextSystemPrompt({ caption: '', detail })
									const model = deps.resolveModel(chatConfig.imageToText.model!)
									const result = await callDescriptionLlm({
										images: [{ url: imageUrl }],
										label: 'read-image',
										log,
										model,
										system,
										userText: 'Describe this image.',
									})
									return result.text.trim()
								}
								: undefined

							tools.push(createReadImageTool({
								downloadAttachment,
								readFile: async (path) => {
									const { execFile } = await import('node:child_process')
									return await new Promise<Buffer>((resolve, reject) => {
										const child = execFile(
											readFileCmd[0]!,
											[...readFileCmd.slice(1), path],
											{ encoding: 'buffer' as any, maxBuffer: deps.runtimeConfig.readFileSizeLimit, timeout: 60_000 },
											(error, stdout) => {
												if (error)
													reject(new Error(`Failed to read file: ${error.message}`))
												else resolve(stdout as unknown as Buffer)
											},
										)
										child.stdin?.end()
									})
								},
								resolveImageToText,
							}))
						}
						tools.push(createKillTaskTool(taskId => deps.backgroundTask.killTask(taskId)))
						tools.push(createReadTaskOutputTool((taskId, offset, limit) => deps.backgroundTask.readTaskOutput(taskId, offset, limit)))

						const scheduleDeps = deps.schedule?.(chatId)
						if (scheduleDeps) {
							tools.push(createScheduleTool(scheduleDeps))
							tools.push(createListSchedulesTool(scheduleDeps))
							tools.push(createCancelScheduleTool(scheduleDeps))
						}

						if (deps.slack) {
							tools.push(createSlackReadChannelInfoTool(() => deps.slack!.readChannelInfo(chatId)))
							tools.push(createSlackReadChannelMembersTool(limit => deps.slack!.readChannelMembers(chatId, limit)))
							tools.push(createSlackReadUserProfileTool(userId => deps.slack!.readUserProfile(userId)))
							tools.push(createSlackListEmojiTool(opts => deps.slack!.listEmoji(opts)))
							tools.push(createSlackReadCanvasTool(opts => deps.slack!.readCanvas(opts)))
						}

						const system = await renderSystemPrompt({
							chatId,
							chatTitle: deps.getChatTitle(chatId),
							currentChannel: 'slack',
							modelName: chatConfig.primaryModel.model,
							...(deps.systemFiles && deps.systemFiles.length > 0
								? { systemFiles: deps.systemFiles }
								: {}),
						})

						// --- Compute mention/reply/interrupt state from RC + TRs ---
						const rcVal = rcAtStart
						const isInterrupted = wasToolLoopInterrupted(trs)
						const lastMentionedAtMs = rcVal.reduce((max, seg) =>
							(seg.mentionsMe || seg.repliesToMe || seg.isRuntimeEvent) ? Math.max(max, seg.receivedAtMs) : max, 0)
						const isMentioned = rcVal.some(seg => seg.mentionsMe && seg.receivedAtMs > lastProcessedMs())
						const isReplied = rcVal.some(seg => seg.repliesToMe && seg.receivedAtMs > lastProcessedMs())
						const isScheduleTriggered = rcVal.some(seg => seg.isScheduleTriggered && seg.receivedAtMs > lastProcessedMs())
						const recentSendMessageHumanLikenessXml = renderRecentSendMessageHumanLikenessXml(
							collectRecentSendMessageAssessments(await deps.loadTurnResponses(chatId)),
						)
						const slackPlacement = computeSlackReplyPlacement(rcVal, lastProcessedMs())
						const slackReplyPlacementXml = slackPlacement
							? renderSlackReplyPlacementXml(slackPlacement)
							: undefined

						const lateBindingParams = {
							activeBackgroundTasks: deps.backgroundTask.getActiveTasks(chatId),
							currentChannel: 'slack',
							isInterrupted,
							isMentioned,
							isReplied,
							isScheduleTriggered,
							recentSendMessageHumanLikenessXml,
							slackEmojiCatalogXml: deps.getSlackEmojiCatalogXml?.(),
							slackReplyPlacementXml,
							timeNow: localTimeNow(),
						}

						// --- Probe gate ---
						// Skip probe if: mentioned, replied to, runtime event, or tool loop was interrupted.
						// In those cases go straight to primary model.
						if (chatConfig.probe.enabled && !isInterrupted) {
							const needsProbe = lastMentionedAtMs <= lastProcessedMs()

							if (needsProbe) {
								log.withFields({ chatId, lastMentionedAtMs, lastProcessedMs: lastProcessedMs() }).log('Running probe')

								const probeEntries = [...ctx.entries]
								injectLateBindingPrompt(probeEntries, await renderLateBindingPrompt({
									...lateBindingParams,
									isProbeEnabled: true,
									isProbing: true,
								}))

								const probeRequestedAt = Date.now()
								const probeResult = await callLlm(
									chatConfig.probe.model,
									probeEntries,
									system,
									tools.map(toToolSchema),
									{ label: `probe:${chatId}`, log, maxImagesAllowed: chatConfig.probe.model.maxImagesAllowed },
								)

								const hasToolCalls = probeResult.entries.some(
									e => e.kind === 'message' && e.role === 'assistant'
										&& e.parts.some(p => p.kind === 'toolCall'),
								)

								log.withFields({ chatId, hasToolCalls }).log('Probe result')

								await deps.persistProbeResponse(chatId, {
									cacheReadTokens: probeResult.usage.cacheReadTokens,
									cacheWriteTokens: probeResult.usage.cacheWriteTokens,
									createdAt: Date.now(),
									entries: probeResult.entries,
									inputTokens: probeResult.usage.inputTokens,
									isActivated: hasToolCalls,
									modelName: chatConfig.probe.model.model,
									outputTokens: probeResult.usage.outputTokens,
									requestedAtMs: probeRequestedAt,
								})

								lastProcessedMs(probeRequestedAt)

								if (!hasToolCalls) {
									log.withFields({ chatId }).log('Probe: model chose silence')
									return
								}
								log.withFields({ chatId }).log('Probe: tool calls detected, activating primary model')
							}
						}

						injectLateBindingPrompt(ctx.entries, await renderLateBindingPrompt({
							...lateBindingParams,
							isProbeEnabled: chatConfig.probe.enabled,
							isProbing: false,
						}))

						const runner = getOrCreateRunner(chatConfig.primaryModel)
						await runner.runStepLoop({
							chatId,
							checkInterrupt: () => {
								if (rc() === rcAtStart)
									return false
								return latestExternalEventMs(rc(), lastProcessedMs()) != null
							},
							entries: ctx.entries,
							log,
							maxImagesAllowed: chatConfig.primaryModel.maxImagesAllowed,
							maxSteps: MAX_STEPS,
							onStepComplete: async (stepEntries, usage, requestedAtMs) => {
								await deps.persistTurnResponse(chatId, {
									cacheReadTokens: usage.cacheReadTokens,
									cacheWriteTokens: usage.cacheWriteTokens,
									entries: stepEntries,
									inputTokens: usage.inputTokens,
									modelName: chatConfig.primaryModel.model,
									outputTokens: usage.outputTokens,
									requestedAtMs,
								})
								lastProcessedMs(requestedAtMs)
							},
							system,
							tools,
						})
					}
					catch (err) {
						// No retry or backoff — a failed call is recorded via failedRc and
						// only re-attempted when new external messages produce a fresh RC.
						log.withError(err).error('LLM call failed')
						failedRc(rcAtStart)
					}
					finally {
						running(false)
					}
				})()
			}, 0)
		})

		// --- Independent compaction effect ---
		let compactionRunning = false
		let compactionTimer: ReturnType<typeof setTimeout> | undefined
		let lastCheckedRc: null | RenderedContext = null

		const disposeCompactionEffect = effect(() => {
			const rcVal = rc()
			if (rcVal.length === 0)
				return

			if (compactionTimer) {
				clearTimeout(compactionTimer)
				compactionTimer = undefined
			}
			if (compactionRunning)
				return
			if (rcVal === lastCheckedRc)
				return

			compactionTimer = setTimeout(() => {
				lastCheckedRc = rc()
				compactionRunning = true

				void (async () => {
					try {
						const cursor = cursorMs()
						const sum = summary()
						const compactEndpoint = chatConfig.compaction.model ?? chatConfig.primaryModel

						const trs = await loadTRs(chatId, cursor)
						const ctx = composeContext(rc(), trs, chatConfig.compaction.maxContextEstTokens, compactEndpoint.model)
						if (!ctx)
							return
						if (ctx.rawEstimatedTokens <= chatConfig.compaction.maxContextEstTokens)
							return

						const newCursorMs = findWorkingWindowCursor(rc(), trs, chatConfig.compaction.workingWindowEstTokens)

						log.withFields({
							chatId,
							newCursorMs,
							oldCursorMs: cursor ?? 0,
							rawEstimatedTokens: ctx.rawEstimatedTokens,
							retainBudget: chatConfig.compaction.workingWindowEstTokens,
							triggerAt: chatConfig.compaction.maxContextEstTokens,
						}).log('Triggering compaction')

						const newMeta = await runCompaction({
							apiBaseUrl: compactEndpoint.apiBaseUrl,
							apiFormat: compactEndpoint.apiFormat,
							apiKey: compactEndpoint.apiKey,
							authPath: compactEndpoint.authPath,
							chatId,
							existingSummary: sum,
							log,
							maxImagesAllowed: compactEndpoint.maxImagesAllowed,
							model: compactEndpoint.model,
							newCursorMs,
							oldCursorMs: cursor ?? 0,
							rcWindow: rc().filter(s => s.receivedAtMs >= (cursor ?? 0) && s.receivedAtMs < newCursorMs),
							timeoutSec: compactEndpoint.timeoutSec,
							trsWindow: trs.filter(t => t.requestedAtMs >= (cursor ?? 0) && t.requestedAtMs < newCursorMs),
						})

						deps.persistCompaction(chatId, newMeta)

						log.withFields({
							chatId,
							newCursorMs,
							summaryLength: newMeta.summary.length,
						}).log('Compaction complete')

						compactionMeta(newMeta)
					}
					catch (err) {
						log.withError(err).error('Compaction failed')
					}
					finally {
						compactionRunning = false
					}
				})()
			}, 0)
		})

		const cleanup = () => {
			if (timer)
				clearTimeout(timer)
			if (compactionTimer)
				clearTimeout(compactionTimer)
			disposeCursorEffect()
			disposeReplyEffect()
			disposeCompactionEffect()
		}

		const entry = { cleanup, rc }
		chatScopes.set(chatId, entry)
		return entry
	}

	const handleEvent = (chatId: string, newRC: RenderedContext) => {
		if (!chatIds.has(chatId))
			return
		getOrCreateScope(chatId).rc(newRC)
	}

	const stop = () => {
		for (const scope of chatScopes.values())
			scope.cleanup()
		chatScopes.clear()
	}

	return { handleEvent, stop }
}
