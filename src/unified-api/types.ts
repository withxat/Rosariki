import type { Sharp } from 'sharp'

/**
 * Unified IR invariants (hold across all producers and consumers):
 *
 * - `ConversationEntry` is `Message | ToolResult`, discriminated by `kind`.
 *   `Message` is further discriminated by `role`: `system`/`user` → `InputMessage`,
 *   `assistant` → `OutputMessage`.
 * - System messages carry only `TextPart`; images/tools on `role: 'system'`
 *   are invalid and rejected at emit time (`assertSystemTextOnly`).
 * - `ToolResult` is a user-side entry — it never appears in `from-*Output`
 *   responses. Historical decoding of stored tool results lives in `migrations.ts`.
 * - `ToolCallPart.args` is the raw wire JSON string. Only the Anthropic emitter
 *   boundary parses it (falling back to `{}` on invalid JSON, since Anthropic's
 *   schema requires an object `input`).
 * - `Extra<S>` is source-tagged: an emitter applies `extra.fields` only when
 *   `extra.source` matches its own target format; otherwise the fields are
 *   dropped. `Extra` lives on model-output nodes only — never on client-authored
 *   `InputMessage` / `ToolResult`.
 * - Reasoning has two carriers: block-level `ReasoningPart` (Responses,
 *   Anthropic, Chat content-part variants) and message-level `MessageReasoning`
 *   (Chat Completions string aliases). Emitters for Chat / Anthropic normalize
 *   opaque-only reasoning to `redacted_thinking` so cross-format round-trip
 *   stays symmetric.
 */

export type ExtraSource = 'anthropicMessages' | 'openaiChatCompletion' | 'openaiResponses'

/** Source-tagged container of provider-specific unknown fields. See IR invariants above. */
export interface Extra<S extends ExtraSource = ExtraSource> {
	readonly fields: Record<string, unknown>
	readonly source: S
}

export interface ThinkingData {
	signature?: string
	thinking: string
	type: 'thinking'
}

export interface RedactedThinkingData {
	data: string
	type: 'redacted_thinking'
}

export interface ResponsesReasoningData {
	encrypted_content?: string
	id: string
	summary: { text: string, type: 'summary_text' }[]
	type: 'reasoning'
}

export type ReasoningData
	= | { data: RedactedThinkingData | ThinkingData, source: 'anthropicMessages' }
		| { data: RedactedThinkingData | ThinkingData, source: 'openaiChatCompletion' }
		| { data: ResponsesReasoningData, source: 'openaiResponses' }

/** Only Chat Completions produces message-level reasoning. Field aliases vary. */
export interface MessageReasoning {
	reasoning?: string
	reasoning_content?: string
	reasoning_opaque?: string
	reasoning_text?: string
}

export interface TextPart {
	extra?: Extra
	kind: 'text'
	/** `true` marks Responses `refusal` blocks so round-trip preserves the block type. */
	refusal?: true
	text: string
}

export interface ImagePart {
	detail: 'high' | 'low' | undefined
	image: Sharp
	kind: 'image'
}

export interface ToolCallPart {
	/**
	 * Raw JSON string from the wire. Anthropic input is stringified at the boundary;
	 *  emission back to Anthropic parses and falls back to `{}` on invalid JSON.
	 */
	args: string
	callId: string
	extra?: Extra
	kind: 'toolCall'
	name: string
}

export interface ReasoningPart {
	data: ReasoningData
	extra?: Extra
	kind: 'reasoning'
}

/**
 * A Responses `message` item's text blocks, preserved as a group so the item
 * boundary (and its id/status/etc. in `extra`) survives round-trip. Chat and
 * Anthropic don't emit this; cross-format conversion flattens to TextPart[].
 */
export interface TextGroupPart {
	content: TextPart[]
	extra?: Extra<'openaiResponses'>
	kind: 'textGroup'
}

export type InputPart = ImagePart | TextPart

export type OutputPart = ReasoningPart | TextGroupPart | TextPart | ToolCallPart

export interface InputMessage {
	kind: 'message'
	parts: InputPart[]
	role: 'system' | 'user'
}

export interface OutputMessage {
	extra?: Extra
	kind: 'message'
	parts: OutputPart[]
	reasoning: MessageReasoning | undefined
	role: 'assistant'
}

export type Message = InputMessage | OutputMessage

export interface ToolResult {
	callId: string
	kind: 'toolResult'
	payload: InputPart[] | string
	requiresFollowUp: boolean
}

export type ConversationEntry = Message | ToolResult
