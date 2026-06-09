import type { RenderedContentPiece, RenderedContext } from '../rendering/types'
import type { ConversationEntry, InputMessage, InputPart } from '../unified-api/types'

function pieceToPart(piece: RenderedContentPiece): InputPart {
	return piece.type === 'text'
		? { kind: 'text', text: piece.text }
		: { detail: 'low', image: piece.image, kind: 'image' }
}

function rcUserMessage(pieces: RenderedContentPiece[]): InputMessage {
	return {
		kind: 'message',
		parts: pieces.map(pieceToPart),
		role: 'user',
	}
}

// Merge RC segments and TR entries into a unified ConversationEntry[] timeline.
//
// RC segments are interleaved with TR entries by timestamp. Each TR's entries
// share the TR's requestedAtMs as their primary sort key; within a TR, original
// array order is preserved via a secondary index. Consecutive RC segments
// (with no TR entries between them) collapse into one user InputMessage.
//
// Tiebreaker on equal timestamps: RC sorts before TR (so user messages precede
// the assistant turn they triggered — Anthropic role alternation stays valid).
export function mergeContext(rc: RenderedContext, trs: { entries: ConversationEntry[], requestedAtMs: number }[]): ConversationEntry[] {
	type Slot
		= | { content: RenderedContentPiece[], kind: 'rc', step: -1, time: number }
			| { entry: ConversationEntry, kind: 'tr', step: number, time: number }

	const slots: Slot[] = []
	for (const seg of rc)
		slots.push({ content: seg.content, kind: 'rc', step: -1, time: seg.receivedAtMs })
	for (const tr of trs) {
		for (let i = 0; i < tr.entries.length; i++)
			slots.push({ entry: tr.entries[i]!, kind: 'tr', step: i, time: tr.requestedAtMs })
	}

	slots.sort((a, b) => {
		if (a.time !== b.time)
			return a.time - b.time
		if (a.kind !== b.kind)
			return a.kind === 'rc' ? -1 : 1
		return a.step - b.step
	})

	const out: ConversationEntry[] = []
	let pending: RenderedContentPiece[] = []
	const flushPending = () => {
		if (pending.length === 0)
			return
		out.push(rcUserMessage(pending))
		pending = []
	}
	for (const slot of slots) {
		if (slot.kind === 'rc') {
			pending.push(...slot.content)
		}
		else {
			flushPending()
			out.push(slot.entry)
		}
	}
	flushPending()
	return out
}
