import type { Sharp } from 'sharp'

import { Buffer } from 'node:buffer'

import sharp from 'sharp'

import { createCodec } from '../unified-api/codec'

interface SharpEncoded {
	base64: string
	format: string
}

function isSharp(v: unknown): v is Sharp {
	return typeof v === 'object' && v !== null
		&& typeof (v as { toBuffer?: unknown }).toBuffer === 'function'
		&& typeof (v as { metadata?: unknown }).metadata === 'function'
}

export const codec = createCodec()

codec.register<Sharp, SharpEncoded>({
	deserialize: async v => sharp(Buffer.from(v.base64, 'base64')),
	isApplicable: isSharp,
	serialize: async (img) => {
		const buf = await img.toBuffer()
		const meta = await sharp(buf).metadata()
		return { base64: buf.toString('base64'), format: meta.format ?? 'png' }
	},
	tag: 'sharp',
})
