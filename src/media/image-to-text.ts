import type { Logger } from '@guiiai/logg'

import type { CanonicalAttachment } from '../adaptation/types'
import type { LlmEndpoint } from '../driver/types'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import sharp from 'sharp'

import { renderImageToTextSystemPrompt } from './image-to-text-prompt'
import { callDescriptionLlm, createSemaphore } from './llm-description'

const IMAGE_TO_TEXT_MAX_EDGE = 512

export interface ImageAltTextRecord {
	altText: string
	altTextTokens: number
	imageHash: string
	stickerSetName?: string
}

export interface ImageToTextResolver {
	hydrateCanonicalAttachments: (attachments: CanonicalAttachment[], caption: string) => Promise<void>
	resolve: (thumbnailBuffer: Buffer, caption: string, highResBuffer?: Buffer) => Promise<ImageAltTextRecord>
}

function hashBuffer(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex')
}

export function computeThumbnailHash(thumbnailWebp: string): string {
	return hashBuffer(Buffer.from(thumbnailWebp, 'base64'))
}

async function prepareImageToTextUrl(buffer: Buffer): Promise<string> {
	const resized = await sharp(buffer)
		.resize(IMAGE_TO_TEXT_MAX_EDGE, IMAGE_TO_TEXT_MAX_EDGE, {
			fit: 'inside',
			withoutEnlargement: true,
		})
		.png()
		.toBuffer()
	return `data:image/png;base64,${resized.toString('base64')}`
}

export function createImageToTextResolver(params: {
	enabled: boolean
	logger: Logger
	lookupByHash: (imageHash: string) => ImageAltTextRecord | null
	maxConcurrency?: number
	model?: LlmEndpoint
	persist: (record: ImageAltTextRecord) => void
}): ImageToTextResolver {
	const log = params.logger.withContext('media:image-to-text')
	const semaphore = createSemaphore(params.maxConcurrency ?? 3)
	const inflightByHash = new Map<string, Promise<ImageAltTextRecord>>()

	const resolveByBuffer = (
		thumbnailBuffer: Buffer,
		caption: string,
		highResBuffer?: Buffer,
	): Promise<ImageAltTextRecord> => {
		const imageHash = hashBuffer(thumbnailBuffer)

		const existing = inflightByHash.get(imageHash)
		if (existing)
			return existing

		const task = (async (): Promise<ImageAltTextRecord> => {
			const cached = params.lookupByHash(imageHash)
			if (cached)
				return cached

			await semaphore.acquire()
			try {
				const recheck = params.lookupByHash(imageHash)
				if (recheck)
					return recheck

				const model = params.model
				if (!model)
					throw new Error('imageToText.model is required when imageToText.enabled=true')

				const imageUrl = await prepareImageToTextUrl(highResBuffer ?? thumbnailBuffer)
				const system = await renderImageToTextSystemPrompt({ caption })

				const result = await callDescriptionLlm({
					images: [{ url: imageUrl }],
					label: 'image-to-text',
					log,
					model,
					system,
					userText: 'Describe this image.',
				})
				const altText = result.text.trim()
				if (!altText)
					throw new Error('Image-to-text model returned empty alt text')

				const record: ImageAltTextRecord = {
					altText,
					altTextTokens: result.outputTokens,
					imageHash,
				}
				params.persist(record)
				return record
			}
			finally {
				semaphore.release()
			}
		})()

		inflightByHash.set(imageHash, task)
		void task.finally(() => inflightByHash.delete(imageHash))
		return task
	}

	return {
		async hydrateCanonicalAttachments(attachments, caption) {
			if (!params.enabled)
				return
			await Promise.all(attachments.map(async (att) => {
				if (att.altText || !att.thumbnailWebp)
					return
				const buffer = Buffer.from(att.thumbnailWebp, 'base64')
				const record = await resolveByBuffer(buffer, caption)
				att.altText = record.altText
			}))
		},

		resolve(thumbnailBuffer, caption, highResBuffer) {
			return resolveByBuffer(thumbnailBuffer, caption, highResBuffer)
		},
	}
}
