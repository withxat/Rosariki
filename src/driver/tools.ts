import type { Buffer } from 'node:buffer'

import type { Logger } from '@guiiai/logg'

import type { CanonicalAttachment } from '../adaptation/types'
import type { RuntimeConfig } from '../config/config'
import type {
	ConversationEntry,
	InputPart,
	ToolResult as IRToolResult,
	ToolCallPart,
} from '../unified-api/types'

import { execFile } from 'node:child_process'

import { Validator } from '@cfworker/json-schema'
import sharp from 'sharp'

export interface ToolResult {
	content: InputPart[] | string
	requiresFollowUp: boolean
}

export function isToolResult(v: unknown): v is ToolResult {
	return typeof v === 'object' && v !== null && 'requiresFollowUp' in v
}

export interface CahciuaToolExecuteOptions {
	toolCallId: string
}

export interface CahciuaTool {
	execute: (input: unknown, options: CahciuaToolExecuteOptions) => Promise<ToolResult> | ToolResult
	function: {
		description?: string
		name: string
		parameters: Record<string, unknown>
		strict?: boolean
	}
	type: 'function'
	validate: (input: unknown) => { errors: string[], valid: boolean }
}

export function createTool(def: {
	description?: string
	execute: CahciuaTool['execute']
	name: string
	parameters: Record<string, unknown>
	strict?: boolean
}): CahciuaTool {
	const validator = new Validator(def.parameters as object)
	return {
		execute: def.execute,
		function: {
			name: def.name,
			parameters: def.parameters,
			...(def.description ? { description: def.description } : {}),
			...(def.strict != null ? { strict: def.strict } : {}),
		},
		type: 'function',
		validate: (input: unknown) => {
			const result = validator.validate(input)
			return {
				errors: result.errors.map(e => `${e.instanceLocation}: ${e.error}`),
				valid: result.valid,
			}
		},
	}
}

export interface SendMessageAttachment {
	file_name?: string
	path: string
	type: 'animation' | 'audio' | 'document' | 'photo' | 'video' | 'video_note' | 'voice'
}

export function createSendMessageTool(send: (text: string, replyTo?: string, attachments?: SendMessageAttachment[]) => Promise<{ messageId: string }>): CahciuaTool {
	const properties: Record<string, unknown> = {
		attachments: {
			description: 'Media attachments to send. Multiple attachments are sent as a media group (album). Telegram media groups support up to 10 items; photos and videos can be mixed, but audio and documents must be grouped separately.',
			items: {
				properties: {
					file_name: { description: 'Override filename (for document type only).', type: 'string' },
					path: { description: 'File path in the workspace.', type: 'string' },
					type: {
						description: 'The type of media to send.',
						enum: ['document', 'photo', 'video', 'audio', 'voice', 'animation', 'video_note'],
						type: 'string',
					},
				},
				required: ['type', 'path'],
				type: 'object',
			},
			type: 'array',
		},
		await_response: {
			description: 'Set to true if you need to perform additional actions after this message (e.g., send another message, use another tool). Defaults to false.',
			type: 'boolean',
		},
		reply_to: { description: 'Slack message id (ts) to reply in-thread. Omit only for an intentional top-level channel message. Follow slack-reply-placement in late-binding when present.', type: 'string' },
		text: { description: 'The message to send. When sending attachments, this becomes the caption.', type: 'string' },
	}

	return createTool({
		description: 'Send a message in the current conversation, optionally with media attachments.',
		execute: async (input) => {
			const { attachments, await_response, reply_to, text } = input as {
				attachments?: SendMessageAttachment[]
				await_response?: boolean
				reply_to?: string
				text: string
			}
			const result = await send(text, reply_to, attachments)
			return {
				content: JSON.stringify({ message_id: result.messageId, ok: true }),
				requiresFollowUp: await_response ?? false,
			}
		},
		name: 'send_message',
		parameters: {
			properties,
			required: ['text'],
			type: 'object',
		},
	})
}

export interface ChatInteractionDeps {
	deleteMessage: (messageId: string) => Promise<void>
	reactToMessage: (messageId: string, reaction: string, operation: 'add' | 'remove') => Promise<void>
	readThread: (messageId: string, limit?: number) => Promise<unknown>
	updateMessage: (messageId: string, text: string) => Promise<{ messageId: string }>
}

export function createChatInteractionTools(deps: ChatInteractionDeps): CahciuaTool[] {
	return [
		createTool({
			description: 'Add or remove a reaction on a Slack message.',
			execute: async (input) => {
				const { message_id, operation, reaction } = input as { message_id: string, operation: 'add' | 'remove', reaction: string }
				await deps.reactToMessage(message_id, reaction, operation)
				return { content: JSON.stringify({ ok: true }), requiresFollowUp: true }
			},
			name: 'react_to_message',
			parameters: {
				properties: {
					message_id: { description: 'The Slack message id / timestamp to react to.', type: 'string' },
					operation: { description: 'Whether to add or remove the reaction.', enum: ['add', 'remove'], type: 'string' },
					reaction: { description: 'Reaction name without colons (e.g. eyes, thumbsup, or a workspace custom name from slack-emoji-catalog / slack_list_emoji).', type: 'string' },
				},
				required: ['message_id', 'reaction', 'operation'],
				type: 'object',
			},
		}),
		createTool({
			description: 'Update a Slack message previously sent by the bot.',
			execute: async (input) => {
				const { message_id, text } = input as { message_id: string, text: string }
				const result = await deps.updateMessage(message_id, text)
				return { content: JSON.stringify({ message_id: result.messageId, ok: true }), requiresFollowUp: true }
			},
			name: 'update_message',
			parameters: {
				properties: {
					message_id: { description: 'The Slack message id / timestamp to update.', type: 'string' },
					text: { description: 'Replacement message text.', type: 'string' },
				},
				required: ['message_id', 'text'],
				type: 'object',
			},
		}),
		createTool({
			description: 'Delete a Slack message previously sent by the bot.',
			execute: async (input) => {
				const { message_id } = input as { message_id: string }
				await deps.deleteMessage(message_id)
				return { content: JSON.stringify({ ok: true }), requiresFollowUp: true }
			},
			name: 'delete_message',
			parameters: {
				properties: {
					message_id: { description: 'The Slack message id / timestamp to delete.', type: 'string' },
				},
				required: ['message_id'],
				type: 'object',
			},
		}),
		createTool({
			description: 'Read replies in a Slack thread.',
			execute: async (input) => {
				const { limit, message_id } = input as { limit?: number, message_id: string }
				const replies = await deps.readThread(message_id, limit)
				return { content: JSON.stringify({ ok: true, replies }), requiresFollowUp: true }
			},
			name: 'read_thread',
			parameters: {
				properties: {
					limit: { description: 'Maximum replies to return, from 1 to 100. Defaults to 20.', type: 'number' },
					message_id: { description: 'The root Slack message id / timestamp of the thread.', type: 'string' },
				},
				required: ['message_id'],
				type: 'object',
			},
		}),
	]
}

const BASH_MAX_OUTPUT = 4096
const BASH_TIMEOUT_MS = 30_000

export function createBashTool(runtime: RuntimeConfig, backgroundTask: {
	backgroundThresholdSec: number
	sessionId: string
	startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number
}): CahciuaTool {
	return createTool({
		description:
    'Execute a shell command. Output (stdout+stderr combined) is truncated to 4 KB. '
    + 'For large outputs, redirect to a file and read specific ranges. '
    + `Set timeout_seconds > ${backgroundTask.backgroundThresholdSec} for long-running commands — they run as background tasks and return immediately with a task ID.`,
		execute: async (input) => {
			const { command, intention, timeout_seconds } = input as { command: string, intention?: string, timeout_seconds: number }
			const timeoutSec = timeout_seconds

			// Background task path
			if (timeoutSec > backgroundTask.backgroundThresholdSec) {
				const taskId = backgroundTask.startTask(
					'shell_execute',
					backgroundTask.sessionId,
					{ command, shell: runtime.shell },
					intention,
					timeoutSec * 1000,
				)
				return {
					content: JSON.stringify({ background_task_id: taskId, message: `Background task started (id: ${taskId}). You will be notified when it completes. Use kill_task to cancel or read_task_output to view results.` }),
					requiresFollowUp: true,
				}
			}

			// Synchronous execution path
			return await new Promise<ToolResult>((resolve) => {
				const child = execFile(
					runtime.shell[0]!,
					[...runtime.shell.slice(1), command],
					{ maxBuffer: BASH_MAX_OUTPUT * 2, timeout: Math.min(timeoutSec * 1000, BASH_TIMEOUT_MS) },
					(error, stdout, stderr) => {
						let output = stdout + stderr
						let truncated = false
						if (output.length > BASH_MAX_OUTPUT) {
							output = output.slice(0, BASH_MAX_OUTPUT)
							truncated = true
						}
						const exitCode = error
							? (error as NodeJS.ErrnoException & { code?: number | string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
									? 'truncated'
									: (child.exitCode ?? 1)
							: 0
						resolve({
							content: JSON.stringify({ exit_code: exitCode, output, truncated }),
							requiresFollowUp: true,
						})
					},
				)
			})
		},
		name: 'bash',
		parameters: {
			properties: {
				command: { description: 'The shell command to execute.', type: 'string' },
				intention: { description: 'Brief description of what this command does (shown in background task status).', type: 'string' },
				timeout_seconds: {
					description: `Timeout in seconds. Commands with timeout > ${backgroundTask.backgroundThresholdSec}s run as background tasks and return immediately with a task ID. Short commands (e.g. ls, cat) typically need 5-10s; builds or tests may need 60-300s.`,
					type: 'number',
				},
			},
			required: ['command', 'timeout_seconds'],
			type: 'object',
		},
	})
}

const WEB_SEARCH_TIMEOUT_MS = 15_000

export function createWebSearchTool(tavilyKey: string): CahciuaTool {
	return createTool({
		description: 'Search the web using Tavily. Returns an answer and up to 5 results.',
		execute: async (input) => {
			const { query } = input as { query: string }
			const resp = await fetch('https://api.tavily.com/search', {
				body: JSON.stringify({
					api_key: tavilyKey,
					include_answer: true,
					max_results: 5,
					query,
					search_depth: 'basic',
				}),
				headers: { 'Content-Type': 'application/json' },
				method: 'POST',
				signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
			})
			if (!resp.ok) {
				const text = await resp.text().catch(() => '')
				return {
					content: JSON.stringify({ detail: text, error: `Tavily API error: ${resp.status}` }),
					requiresFollowUp: true,
				}
			}
			const data = await resp.json() as { answer?: string, results?: { content: string, title: string, url: string }[] }
			return {
				content: JSON.stringify({
					answer: data.answer ?? null,
					results: (data.results ?? []).map(r => ({ snippet: r.content, title: r.title, url: r.url })),
				}),
				requiresFollowUp: true,
			}
		},
		name: 'web_search',
		parameters: {
			properties: {
				query: { description: 'The search query.', type: 'string' },
			},
			required: ['query'],
			type: 'object',
		},
	})
}

const DOWNLOAD_TIMEOUT_MS = 60_000

/** Shared file_id → Buffer logic used by download_file and read_image tools. */
export function createAttachmentDownloader(deps: {
	chatId: string
	downloadPlatformFile: (platformFileId: string) => Promise<Buffer | undefined>
	loadMessageAttachments: (chatId: string, messageId: string) => CanonicalAttachment[] | undefined
}): (fileId: string) => Promise<Buffer> {
	return async (fileId: string): Promise<Buffer> => {
		const colonIdx = fileId.lastIndexOf(':')
		if (colonIdx < 0)
			throw new Error('Invalid file_id format. Expected "messageId:index".')

		const messageId = fileId.slice(0, colonIdx)
		const attachmentIndex = Number.parseInt(fileId.slice(colonIdx + 1), 10)
		if (Number.isNaN(attachmentIndex) || attachmentIndex < 0)
			throw new Error('Invalid file_id: attachment index is not a valid number.')

		const attachments = deps.loadMessageAttachments(deps.chatId, messageId)
		if (!attachments || attachments.length === 0)
			throw new Error(`No attachments found for message ${messageId}.`)
		if (attachmentIndex >= attachments.length)
			throw new Error(`Attachment index ${attachmentIndex} out of range (message has ${attachments.length} attachments).`)

		const att = attachments[attachmentIndex]!
		if (!att.platformFileId)
			throw new Error('Attachment has no platform file id.')

		const buffer = await deps.downloadPlatformFile(att.platformFileId)
		if (!buffer)
			throw new Error('Failed to download file from Slack.')

		return buffer
	}
}

export function createDownloadFileTool(deps: {
	downloadAttachment: (fileId: string) => Promise<Buffer>
	runtime: RuntimeConfig
}): CahciuaTool {
	return createTool({
		description: 'Download a file attachment from the chat to a local path. Use the file-id attribute from attachment elements in the chat context.',
		execute: async (input) => {
			const { file_id, path } = input as { file_id: string, path: string }

			let buffer: Buffer
			try {
				buffer = await deps.downloadAttachment(file_id)
			}
			catch (err) {
				return { content: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), requiresFollowUp: true }
			}

			if (buffer.length > deps.runtime.writeFileSizeLimit) {
				return {
					content: JSON.stringify({ error: `File too large: ${buffer.length} bytes exceeds limit of ${deps.runtime.writeFileSizeLimit} bytes.` }),
					requiresFollowUp: true,
				}
			}

			const writeCmd = deps.runtime.writeFile
			return await new Promise<ToolResult>((resolve) => {
				const child = execFile(
					writeCmd[0]!,
					[...writeCmd.slice(1), path],
					{ maxBuffer: 1024, timeout: DOWNLOAD_TIMEOUT_MS },
					(error, _stdout, stderr) => {
						if (error) {
							resolve({
								content: JSON.stringify({ error: `Failed to write file: ${stderr || error.message}` }),
								requiresFollowUp: true,
							})
						}
						else {
							resolve({
								content: JSON.stringify({ ok: true, path, size: buffer!.length }),
								requiresFollowUp: true,
							})
						}
					},
				)
				child.stdin?.end(buffer)
			})
		},
		name: 'download_file',
		parameters: {
			properties: {
				file_id: { description: 'The file-id attribute from an attachment element (format: messageId:index).', type: 'string' },
				path: { description: 'Destination file path in the workspace.', type: 'string' },
			},
			required: ['file_id', 'path'],
			type: 'object',
		},
	})
}

export function createKillTaskTool(kill: (taskId: number) => { error?: string, ok: boolean }): CahciuaTool {
	return createTool({
		description: 'Kill a running background task by its ID.',
		execute: (input) => {
			const { task_id } = input as { task_id: number }
			const result = kill(task_id)
			return { content: JSON.stringify(result), requiresFollowUp: true }
		},
		name: 'kill_task',
		parameters: {
			properties: {
				task_id: { description: 'The background task ID to kill.', type: 'number' },
			},
			required: ['task_id'],
			type: 'object',
		},
	})
}

export function createSlackReadChannelInfoTool(read: () => Promise<unknown>): CahciuaTool {
	return createTool({
		description: 'Read metadata for the current Slack channel, including topic, purpose, privacy/archive flags, and member count when Slack provides it.',
		execute: async () => ({
			content: JSON.stringify(await read()),
			requiresFollowUp: true,
		}),
		name: 'slack_read_channel_info',
		parameters: {
			properties: {},
			type: 'object',
		},
	})
}

export function createSlackReadChannelMembersTool(read: (limit?: number) => Promise<unknown>): CahciuaTool {
	return createTool({
		description: 'Read member user IDs for the current Slack channel. Use this before reasoning about who is in the channel.',
		execute: async (input) => {
			const { limit } = input as { limit?: number }
			return { content: JSON.stringify(await read(limit)), requiresFollowUp: true }
		},
		name: 'slack_read_channel_members',
		parameters: {
			properties: {
				limit: { description: 'Maximum members to return. Default 200.', type: 'number' },
			},
			type: 'object',
		},
	})
}

export function createSlackReadUserProfileTool(read: (userId: string) => Promise<unknown>): CahciuaTool {
	return createTool({
		description: 'Read a Slack user profile by user ID. Accepts either raw Slack IDs like U123 or canonical IDs like slack:U123.',
		execute: async (input) => {
			const { user_id } = input as { user_id: string }
			return { content: JSON.stringify(await read(user_id)), requiresFollowUp: true }
		},
		name: 'slack_read_user_profile',
		parameters: {
			properties: {
				user_id: { description: 'Slack user ID, e.g. U123, or canonical slack:U123.', type: 'string' },
			},
			required: ['user_id'],
			type: 'object',
		},
	})
}

export function createSlackListEmojiTool(list: (opts: { includeStandard?: boolean, includeUrls?: boolean, limit?: number, query?: string }) => Promise<unknown>): CahciuaTool {
	return createTool({
		description: 'List Slack workspace emoji. This includes custom emoji and can include Slack standard emoji categories when available.',
		execute: async (input) => {
			const { include_standard, include_urls, limit, query } = input as {
				include_standard?: boolean
				include_urls?: boolean
				limit?: number
				query?: string
			}
			return {
				content: JSON.stringify(await list({
					includeStandard: include_standard,
					includeUrls: include_urls,
					limit,
					query,
				})),
				requiresFollowUp: true,
			}
		},
		name: 'slack_list_emoji',
		parameters: {
			properties: {
				include_standard: { description: 'Include Slack standard emoji categories. Default true.', type: 'boolean' },
				include_urls: { description: 'Include custom emoji image URLs. Default false.', type: 'boolean' },
				limit: { description: 'Maximum custom emoji names to return. Default 500. Use 0 to return all matching custom emoji.', type: 'number' },
				query: { description: 'Optional case-insensitive substring filter for emoji names.', type: 'string' },
			},
			type: 'object',
		},
	})
}

export function createSlackReadCanvasTool(read: (opts: { canvasId: string, containsText?: string, sectionTypes?: Array<'any_header' | 'h1' | 'h2' | 'h3'> }) => Promise<unknown>): CahciuaTool {
	return createTool({
		description: 'Read Slack canvas section lookup results. Slack currently exposes section lookup by canvas_id, header type, and optional text search.',
		execute: async (input) => {
			const { canvas_id, contains_text, section_types } = input as {
				canvas_id: string
				contains_text?: string
				section_types?: Array<'any_header' | 'h1' | 'h2' | 'h3'>
			}
			return {
				content: JSON.stringify(await read({
					canvasId: canvas_id,
					containsText: contains_text,
					sectionTypes: section_types,
				})),
				requiresFollowUp: true,
			}
		},
		name: 'slack_read_canvas',
		parameters: {
			properties: {
				canvas_id: { description: 'Encoded Slack canvas ID.', type: 'string' },
				contains_text: { description: 'Optional text to search for inside sections.', type: 'string' },
				section_types: {
					description: 'Header section types to locate. Defaults to any_header.',
					items: { enum: ['any_header', 'h1', 'h2', 'h3'], type: 'string' },
					type: 'array',
				},
			},
			required: ['canvas_id'],
			type: 'object',
		},
	})
}

export function createReadTaskOutputTool(read: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string, totalLines: number, truncated: boolean } | { error: string }>): CahciuaTool {
	return createTool({
		description:
    'Read the full output of a completed background task. Supports pagination for large outputs. '
    + 'Use offset and limit to read specific ranges (line-based).',
		execute: async (input) => {
			const { limit, offset, task_id } = input as { limit?: number, offset?: number, task_id: number }
			const result = await read(task_id, offset, limit)
			return { content: JSON.stringify(result), requiresFollowUp: true }
		},
		name: 'read_task_output',
		parameters: {
			properties: {
				limit: { description: 'Number of lines to read. Default: 200.', type: 'number' },
				offset: { description: 'Starting line number (0-based). Default: 0.', type: 'number' },
				task_id: { description: 'The background task ID.', type: 'number' },
			},
			required: ['task_id'],
			type: 'object',
		},
	})
}

// ── read_image tool ──

async function prepareImage(buffer: Buffer, detail: 'high' | 'low'): Promise<Buffer> {
	const maxEdge = detail === 'high' ? 1024 : 512
	return await sharp(buffer)
		.resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
		.png()
		.toBuffer()
}

export function createReadImageTool(deps: {
	downloadAttachment: (fileId: string) => Promise<Buffer>
	readFile: (path: string) => Promise<Buffer>
	resolveImageToText?: (buffer: Buffer, detail: 'high' | 'low') => Promise<string>
}): CahciuaTool {
	return createTool({
		description: 'Read and analyze an image from a chat attachment or the filesystem.',
		execute: async (input) => {
			const { detail: rawDetail, file_id, path } = input as { detail?: string, file_id?: string, path?: string }
			const detail: 'high' | 'low' = rawDetail === 'high' ? 'high' : 'low'

			if ((!file_id && !path) || (file_id && path))
				return { content: JSON.stringify({ error: 'Provide exactly one of file_id or path.' }), requiresFollowUp: true }

			// 1. Acquire buffer
			let buffer: Buffer
			try {
				buffer = file_id
					? await deps.downloadAttachment(file_id)
					: await deps.readFile(path!)
			}
			catch (err) {
				return { content: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }), requiresFollowUp: true }
			}

			// 2. Validate image via sharp
			try {
				await sharp(buffer).metadata()
			}
			catch {
				return { content: JSON.stringify({ error: 'File is not a valid image.' }), requiresFollowUp: true }
			}

			// 3. Prepare image
			const resizedBuffer = await prepareImage(buffer, detail)

			// 4. Return
			if (deps.resolveImageToText) {
				const description = await deps.resolveImageToText(resizedBuffer, detail)
				return { content: JSON.stringify({ description, ok: true }), requiresFollowUp: true }
			}

			return {
				content: [{ detail, image: sharp(resizedBuffer), kind: 'image' }] satisfies InputPart[],
				requiresFollowUp: true,
			}
		},
		name: 'read_image',
		parameters: {
			properties: {
				detail: {
					description: 'Resolution level. Use "high" to read fine details or text in the image. Default: low.',
					enum: ['low', 'high'],
					type: 'string',
				},
				file_id: {
					description: 'The file-id from an attachment element (format: messageId:index).',
					type: 'string',
				},
				path: {
					description: 'Filesystem path to an image file.',
					type: 'string',
				},
			},
			type: 'object',
		},
	})
}

/** Extract ToolCallParts from assistant OutputMessage entries. */
export function extractToolCalls(entries: ConversationEntry[]): ToolCallPart[] {
	const calls: ToolCallPart[] = []
	for (const e of entries) {
		if (e.kind === 'message' && e.role === 'assistant') {
			for (const p of e.parts) {
				if (p.kind === 'toolCall')
					calls.push(p)
			}
		}
	}
	return calls
}

function toolError(id: string, message: string): IRToolResult {
	return {
		callId: id,
		kind: 'toolResult',
		payload: JSON.stringify({ error: message }),
		requiresFollowUp: true,
	}
}

/** Execute a tool call against the tools list, returning an IR ToolResult. */
export async function executeToolCall(id: string, name: string, args: string, tools: CahciuaTool[], log: Logger): Promise<IRToolResult> {
	const tool = tools.find(t => t.function.name === name)
	if (!tool)
		return toolError(id, `Unknown tool: ${name}`)

	let parsed: unknown
	try {
		parsed = JSON.parse(args)
	}
	catch {
		log.withFields({ args, tool: name }).error('Tool call has invalid JSON args')
		return toolError(id, `Invalid JSON in tool arguments: ${args.slice(0, 200)}`)
	}

	const { errors, valid } = tool.validate(parsed)
	if (!valid) {
		log.withFields({ errors, tool: name }).error('Tool call args failed schema validation')
		return toolError(id, `Arguments do not match schema: ${errors.join('; ')}`)
	}

	try {
		const rawResult = await tool.execute(parsed, { toolCallId: id })
		const { content, requiresFollowUp } = isToolResult(rawResult)
			? rawResult
			: { content: JSON.stringify(rawResult), requiresFollowUp: true }
		return {
			callId: id,
			kind: 'toolResult',
			payload: content as InputPart[] | string,
			requiresFollowUp,
		}
	}
	catch (err) {
		log.withError(err).error(`Tool ${name} failed`)
		return toolError(id, String(err))
	}
}
