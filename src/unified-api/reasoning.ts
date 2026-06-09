import type { ConversationEntry, MessageReasoning, ResponsesReasoningData } from './types'

export function flattenResponsesSummary(summary: ResponsesReasoningData['summary']): string {
	return summary.map(s => s.text).join('\n')
}

export function messageReasoningText(r: MessageReasoning): string | undefined {
	return [r.reasoning_content, r.reasoning, r.reasoning_text].find(
		(v): v is string => typeof v === 'string' && v.length > 0,
	)
}

/** Returns a new array; does not mutate. */
export function stripReasoning(entries: ConversationEntry[]): ConversationEntry[] {
	return entries.map((entry) => {
		if (entry.kind !== 'message' || entry.role !== 'assistant')
			return entry
		const hasParts = entry.parts.some(p => p.kind === 'reasoning')
		const hasData = entry.reasoning !== undefined
		if (!hasParts && !hasData)
			return entry
		return {
			...entry,
			parts: hasParts ? entry.parts.filter(p => p.kind !== 'reasoning') : entry.parts,
			reasoning: undefined,
		}
	})
}
