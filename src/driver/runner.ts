import type { Logger } from '@guiiai/logg'

import type {
	ConversationEntry,
	ToolResult,
} from '../unified-api/types'
import type { LlmCallConfig, LlmCallUsage, ToolSchema } from './call-llm'
import type { CahciuaTool } from './tools'

import { callLlm } from './call-llm'
import { ensureDumpDir } from './constants'
import { executeToolCall, extractToolCalls } from './tools'

ensureDumpDir()

export interface RunnerConfig extends LlmCallConfig {}

interface StepLoopParams {
	chatId: string
	checkInterrupt: () => boolean
	entries: ConversationEntry[]
	log: Logger
	maxImagesAllowed?: number
	maxSteps: number
	onStepComplete: (
		stepEntries: ConversationEntry[],
		usage: LlmCallUsage,
		requestedAtMs: number,
	) => Promise<void> | void
	system: string
	tools: CahciuaTool[]
}

function toToolSchema(t: CahciuaTool): ToolSchema {
	return {
		name: t.function.name,
		parameters: t.function.parameters,
		...(t.function.description ? { description: t.function.description } : {}),
	}
}

export function createRunner(config: RunnerConfig) {
	const runOneStep = async (
		workingEntries: ConversationEntry[],
		params: StepLoopParams,
		step: number,
	): Promise<{
		hasToolCalls: boolean
		requestedAtMs: number
		stepEntries: ConversationEntry[]
		usage: LlmCallUsage
	}> => {
		const stepRequestedAt = Date.now()
		const toolSchemas = params.tools.map(toToolSchema)

		const result = await callLlm(config, workingEntries, params.system, toolSchemas, {
			dumpId: params.chatId,
			label: `step:${step}`,
			log: params.log,
			maxImagesAllowed: params.maxImagesAllowed,
		})

		const usage = result.usage

		if (result.entries.length === 0)
			return { hasToolCalls: false, requestedAtMs: stepRequestedAt, stepEntries: [], usage }

		const toolCalls = extractToolCalls(result.entries)
		const toolResults: ToolResult[] = []
		for (const tc of toolCalls)
			toolResults.push(await executeToolCall(tc.callId, tc.name, tc.args, params.tools, params.log))

		return {
			hasToolCalls: toolCalls.length > 0,
			requestedAtMs: stepRequestedAt,
			stepEntries: [...result.entries, ...toolResults],
			usage,
		}
	}

	const runStepLoop = async (params: StepLoopParams): Promise<void> => {
		let working: ConversationEntry[] = [...params.entries]

		for (let step = 1; step <= params.maxSteps; step++) {
			const { hasToolCalls, requestedAtMs, stepEntries, usage }
				= await runOneStep(working, params, step)

			if (stepEntries.length === 0) {
				params.log.withFields({ chatId: params.chatId, step }).log('Model chose to stay silent')
				await params.onStepComplete([], usage, requestedAtMs)
				break
			}

			const toolResults = stepEntries.filter((e): e is ToolResult => e.kind === 'toolResult')
			const anyRequiresFollowUp = toolResults.some(tr => tr.requiresFollowUp)

			params.log.withFields({
				chatId: params.chatId,
				hasToolCalls,
				newEntries: stepEntries.length,
				step,
				usage,
			}).log('Step completed')

			await params.onStepComplete(stepEntries, usage, requestedAtMs)

			if (!hasToolCalls || !anyRequiresFollowUp) {
				if (hasToolCalls && !anyRequiresFollowUp)
					params.log.withFields({ chatId: params.chatId, step }).log('All tool calls completed without follow-up')
				break
			}
			if (params.checkInterrupt()) {
				params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages')
				break
			}

			working = [...working, ...stepEntries]
		}
	}

	return { runStepLoop }
}
