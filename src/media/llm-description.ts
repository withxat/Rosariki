import type { Logger } from '@guiiai/logg'

import type { LlmEndpoint } from '../driver/types'

import { chatCompletions } from '../driver/chat'
import { responsesApi } from '../driver/responses'

export function createSemaphore(max: number) {
	let current = 0
	const queue: (() => void)[] = []
	return {
		acquire: () => new Promise<void>((resolve) => {
			if (current < max) {
				current++
				resolve()
			}
			else {
				queue.push(resolve)
			}
		}),
		release: () => {
			current--
			const next = queue.shift()
			if (next) {
				current++
				next()
			}
		},
	}
}

function extractChatText(message?: { content?: null | string | { text?: string }[] }): string {
	if (!message?.content)
		return ''
	if (typeof message.content === 'string')
		return message.content.trim()
	return message.content
		.map(part => part.text ?? '')
		.join('')
		.trim()
}

function extractResponsesText(output: Array<{ content?: Array<{ refusal?: string, text?: string, type: string }>, role?: string, type: string }>): string {
	return output
		.filter(item => item.type === 'message' && item.role === 'assistant')
		.flatMap(item => item.content ?? [])
		.map(block => block.type === 'output_text' ? (block.text ?? '') : (block.refusal ?? ''))
		.join('')
		.trim()
}

export interface ImageContentPart {
	detail?: 'auto' | 'high' | 'low'
	url: string
}

export async function callDescriptionLlm(params: {
	images: ImageContentPart[]
	label: string
	log: Logger
	model: LlmEndpoint
	system: string
	userText: string
}): Promise<{ outputTokens: number, text: string }> {
	const { images, label, log, model, system, userText } = params

	log.withFields({ apiFormat: model.apiFormat ?? 'openai-chat', images: images.length, systemLen: system.length }).log(`${label} request`)

	if ((model.apiFormat ?? 'openai-chat') === 'responses') {
		const input = [{
			content: [
				{ text: userText, type: 'input_text' },
				...images.map(img => ({ detail: img.detail ?? 'high' as const, image_url: img.url, type: 'input_image' })),
			],
			role: 'user',
			type: 'message',
		}]
		const response = await responsesApi({
			apiKey: model.apiKey,
			baseURL: model.apiBaseUrl,
			input,
			instructions: system,
			label,
			log,
			model: model.model,
			timeoutSec: model.timeoutSec,
		})

		return {
			outputTokens: response.usage.outputTokens,
			text: extractResponsesText(response.output as Array<{ content?: Array<{ refusal?: string, text?: string, type: string }>, role?: string, type: string }>),
		}
	}

	const chatMessages = [{
		content: [
			{ text: userText, type: 'text' as const },
			...images.map(img => ({ image_url: { detail: img.detail ?? 'high' as const, url: img.url }, type: 'image_url' as const })),
		],
		role: 'user' as const,
	}]
	const response = await chatCompletions({
		apiKey: model.apiKey,
		baseURL: model.apiBaseUrl,
		label,
		log,
		messages: chatMessages,
		model: model.model,
		system,
		timeoutSec: model.timeoutSec,
	})

	return {
		outputTokens: response.usage.outputTokens,
		text: extractChatText(response.choices[0]?.message),
	}
}
