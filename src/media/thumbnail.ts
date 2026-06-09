import type { Buffer } from 'node:buffer'

import sharp from 'sharp'

// Target ~100 tokens per image under Claude's formula: tokens = ceil(w*h / 750).
const THUMBNAIL_MAX_PIXELS = 75000

export async function generateThumbnail(buffer: Buffer): Promise<string> {
	const meta = await sharp(buffer).metadata()
	const w = meta.width ?? 512
	const h = meta.height ?? 512

	const longEdge = Math.max(w, h)
	const shortEdge = Math.min(w, h)
	const ratio = longEdge / shortEdge
	const maxLongEdge = Math.floor(Math.sqrt(THUMBNAIL_MAX_PIXELS * ratio))

	const webp = await sharp(buffer)
		.resize(maxLongEdge, maxLongEdge, { fit: 'inside', withoutEnlargement: true })
		.webp({ quality: 80 })
		.toBuffer()
	return webp.toString('base64')
}
