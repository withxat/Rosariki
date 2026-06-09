import type { Buffer } from 'node:buffer'

import type { Sharp } from 'sharp'

import type { ChatCompletionsContentPart, ResponsesInputContent } from './chat-types'
import type { Extra, ExtraSource, ImagePart, InputPart } from './types'

/**
 * Capture `obj` keys outside `coreKeys` into `Extra.fields` so unknown
 *  provider extensions round-trip without being mistaken for modeled fields.
 */
export function pickExtra<S extends ExtraSource>(source: S, obj: object, coreKeys: ReadonlySet<string>): Extra<S> | undefined {
	const fields = Object.fromEntries(
		Object.entries(obj).filter(([k]) => !coreKeys.has(k)),
	)
	return Object.keys(fields).length > 0 ? { fields, source } : undefined
}

/**
 * Merge same-source `extra.fields` under `core` so archived provider extensions
 * round-trip, but modeled core fields always win. Extras from a different
 * source are dropped.
 */
export function applyExtra<T extends Record<string, unknown>>(extra: Extra | undefined, source: ExtraSource, core: T): T & Record<string, unknown> {
	const extraFields = extra?.source === source ? extra.fields : {}
	return { ...extraFields, ...core }
}

export function requireImageFormat(format: string | undefined): string {
	if (format === undefined)
		throw new Error('Image has no recognizable format')
	return format
}

export function assertSystemTextOnly(msg: { parts: { kind: string }[], role: string }): void {
	if (msg.role === 'system' && msg.parts.some(p => p.kind !== 'text')) {
		throw new Error('System message parts must be text')
	}
}

interface EncodedImage {
	buf: Buffer
	format: string
}

const MAX_EDGE: Record<'high' | 'low', number> = { high: 1024, low: 512 }

const encodeCache = new WeakMap<Sharp, Map<'high' | 'low', Promise<EncodedImage>>>()

export function sharpToEncoded(part: ImagePart): Promise<EncodedImage> {
	const detail = part.detail ?? 'high'
	let perImage = encodeCache.get(part.image)
	if (perImage === undefined) {
		perImage = new Map()
		encodeCache.set(part.image, perImage)
	}
	const cached = perImage.get(detail)
	if (cached !== undefined)
		return cached
	const promise = (async (): Promise<EncodedImage> => {
		const resized = part.image.clone().resize({
			fit: 'inside',
			height: MAX_EDGE[detail],
			width: MAX_EDGE[detail],
			withoutEnlargement: true,
		})
		const [buf, meta] = await Promise.all([resized.toBuffer(), resized.metadata()])
		return { buf, format: requireImageFormat(meta.format) }
	})()
	perImage.set(detail, promise)
	return promise
}

export async function sharpToDataUrl(part: ImagePart): Promise<string> {
	const { buf, format } = await sharpToEncoded(part)
	return `data:image/${format};base64,${buf.toString('base64')}`
}

/**
 * Convert an InputPart to a Responses content block.
 */
export async function inputPartToResponsesContent(part: InputPart): Promise<ResponsesInputContent> {
	if (part.kind === 'text') {
		return { text: part.text, type: 'input_text' }
	}
	return {
		detail: part.detail ?? 'auto',
		image_url: await sharpToDataUrl(part),
		type: 'input_image',
	}
}

/**
 * Convert an InputPart to a Chat Completions content part.
 * Chat Completions uses `{type:'text'}` and `{type:'image_url', image_url:{url,detail}}`.
 */
export async function inputPartToChatContent(part: InputPart): Promise<ChatCompletionsContentPart> {
	if (part.kind === 'text') {
		return { text: part.text, type: 'text' }
	}
	return {
		image_url: { detail: part.detail ?? 'auto', url: await sharpToDataUrl(part) },
		type: 'image_url',
	}
}
