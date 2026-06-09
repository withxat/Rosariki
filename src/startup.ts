export function isConfiguredChat(configuredChatIds: ReadonlySet<string>, chatId: string): boolean {
	return configuredChatIds.has(chatId)
}

export function selectStartupReplayChatIds(knownChatIds: readonly string[], configuredChatIds: Iterable<string>): string[] {
	const configured = new Set(configuredChatIds)
	return knownChatIds.filter(chatId => configured.has(chatId))
}
