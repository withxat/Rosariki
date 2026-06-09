import type { CompactionConfig, LlmEndpoint, ProviderFormat } from '../driver/types'

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { merge } from 'es-toolkit'
import * as v from 'valibot'
import { parse as parseYaml } from 'yaml'

const llmEndpointEntries = {
	apiBaseUrl: v.string(),
	apiFormat: v.optional(v.picklist(['openai-chat', 'responses', 'anthropic-messages'])),
	apiKey: v.string(),
	maxImagesAllowed: v.optional(v.number()),
	model: v.string(),
	timeoutSec: v.optional(v.number()),
}

// --- Runtime config schema (top-level, global) ---

const DEFAULT_FILE_SIZE_LIMIT = 20 * 1024 * 1024 // 20 MB

const RuntimeSchema = v.object({
	readFile: v.array(v.string()),
	readFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
	shell: v.optional(v.array(v.string()), ['/bin/bash', '-c']),
	writeFile: v.array(v.string()),
	writeFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
})

// --- Chat-level config schemas ---

const ChatConfigSchema = v.object({
	compaction: v.optional(v.object({
		maxContextEstTokens: v.optional(v.number(), 200000),
		model: v.optional(v.string()),
		workingWindowEstTokens: v.optional(v.number(), 8000),
	}), {}),
	imageToText: v.optional(v.object({
		enabled: v.optional(v.boolean(), false),
		model: v.optional(v.string(), ''),
	}), {}),
	model: v.optional(v.string(), 'primary'),
	probe: v.optional(v.object({
		enabled: v.optional(v.boolean(), false),
		model: v.optional(v.string(), ''),
	}), {}),
	tools: v.object({
		bash: v.optional(v.object({
			backgroundThresholdSec: v.optional(v.number(), 10),
		}), {}),
		webSearch: v.object({
			tavilyKey: v.pipe(v.string(), v.minLength(1)),
		}),
	}),
})

// Per-chat overrides: all fields optional, no defaults
const ChatOverrideSchema = v.optional(v.partial(v.object({
	compaction: v.partial(v.object({
		maxContextEstTokens: v.number(),
		model: v.string(),
		workingWindowEstTokens: v.number(),
	})),
	imageToText: v.partial(v.object({
		enabled: v.boolean(),
		model: v.string(),
	})),
	model: v.string(),
	probe: v.partial(v.object({
		enabled: v.boolean(),
		model: v.string(),
	})),
	tools: v.partial(v.object({
		bash: v.partial(v.object({
			backgroundThresholdSec: v.number(),
		})),
		webSearch: v.partial(v.object({
			tavilyKey: v.string(),
		})),
	})),
})), {})

const BackgroundTasksSchema = v.optional(v.object({
	outputDir: v.optional(v.string(), './data/task-outputs'),
	retentionCount: v.optional(v.number(), 20),
}), {})

const AgentSchema = v.optional(v.object({
	dir: v.optional(v.string(), './agent'),
	displayName: v.optional(v.string(), 'Cahciua'),
}), {})

const ConfigSchema = v.object({
	agent: AgentSchema,
	backgroundTasks: BackgroundTasksSchema,
	chats: v.objectWithRest({ default: ChatConfigSchema }, ChatOverrideSchema),
	database: v.optional(v.object({
		path: v.optional(v.string(), './data/cahciua.db'),
	}), {}),
	models: v.record(v.string(), v.object(llmEndpointEntries)),
	runtime: RuntimeSchema,
	slack: v.object({
		appToken: v.string(),
		botToken: v.string(),
		botUserId: v.optional(v.string()),
		signingSecret: v.optional(v.string()),
	}),
})

export type Config = v.InferOutput<typeof ConfigSchema>
export type ChatConfig = v.InferOutput<typeof ChatConfigSchema>

export interface RuntimeConfig {
	readFile: string[]
	readFileSizeLimit: number
	shell: string[]
	writeFile: string[]
	writeFileSizeLimit: number
}

export interface BackgroundTasksConfig {
	outputDir: string
	retentionCount: number
}

export interface AgentConfig {
	dir: string
	displayName: string
}

export interface ResolvedChatConfig {
	compaction: CompactionConfig
	imageToText: { enabled: boolean, model?: string }
	primaryApiFormat: ProviderFormat
	primaryModel: LlmEndpoint
	probe: { enabled: boolean, model: LlmEndpoint }
	tools: {
		bash: { backgroundThresholdSec: number }
		webSearch: { tavilyKey: string }
	}
}

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config.yaml'

export function loadConfig(): Config {
	const raw = readFileSync(CONFIG_PATH, 'utf-8')
	const parsed = parseYaml(raw)
	return v.parse(ConfigSchema, parsed)
}

export function resolveRuntime(config: Config): RuntimeConfig {
	return {
		readFile: config.runtime.readFile,
		readFileSizeLimit: config.runtime.readFileSizeLimit,
		shell: config.runtime.shell,
		writeFile: config.runtime.writeFile,
		writeFileSizeLimit: config.runtime.writeFileSizeLimit,
	}
}

export function resolveBackgroundTasks(config: Config): BackgroundTasksConfig {
	return {
		outputDir: config.backgroundTasks.outputDir,
		retentionCount: config.backgroundTasks.retentionCount,
	}
}

export function resolveAgent(config: Config): AgentConfig {
	return {
		dir: process.env.AGENT_DIR ?? config.agent.dir,
		displayName: config.agent.displayName,
	}
}

export function resolveModel(config: Config, name: string): LlmEndpoint {
	const entry = config.models[name]
	if (!entry)
		throw new Error(`Unknown model "${name}" — not found in models registry`)
	return entry
}

/** Return whitelisted chat IDs (all keys in chats except "default"). */
export function getChatIds(config: Config): string[] {
	return Object.keys(config.chats).filter(k => k !== 'default')
}

/** Deep-merge default chat config with per-chat overrides and resolve model names. */
export function resolveChatConfig(config: Config, chatId: string): ResolvedChatConfig {
	const override = config.chats[chatId] ?? {}
	const merged: ChatConfig = merge(structuredClone(config.chats.default), override)

	const primaryModel = resolveModel(config, merged.model)
	const primaryApiFormat: ProviderFormat = primaryModel.apiFormat ?? 'openai-chat'

	return {
		compaction: {
			...merged.compaction,
			model: merged.compaction.model ? resolveModel(config, merged.compaction.model) : undefined,
		},
		imageToText: {
			enabled: merged.imageToText.enabled,
			model: merged.imageToText.model || undefined,
		},
		primaryApiFormat,
		primaryModel,
		probe: {
			enabled: merged.probe.enabled,
			model: merged.probe.model ? resolveModel(config, merged.probe.model) : primaryModel,
		},
		tools: {
			bash: { backgroundThresholdSec: merged.tools.bash.backgroundThresholdSec },
			webSearch: { tavilyKey: merged.tools.webSearch.tavilyKey },
		},
	}
}
