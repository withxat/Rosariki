declare module 'lottie-frame' {
	import type { Buffer } from 'node:buffer'

	export function exportFrame(data: Buffer, options: {
		frame: number
		height: number
		quality?: number
		width: number
	}): Promise<Buffer>

	export function exportFrameSync(data: Buffer, options: {
		frame: number
		height: number
		quality?: number
		width: number
	}): Buffer
}
