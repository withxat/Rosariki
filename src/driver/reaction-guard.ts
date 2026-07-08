export interface RecentReaction {
	atMs: number
	messageId: string
	senderId: string
}

export interface ReactionGuard {
	checkAdd: (senderId: string | undefined, messageId: string) => { allowed: boolean, reason?: string }
	recordAdd: (senderId: string | undefined, messageId: string) => void
}

const DEFAULT_WINDOW_MS = 120_000

export function createReactionGuard(_chatId: string, windowMs = DEFAULT_WINDOW_MS): ReactionGuard {
	const recent: RecentReaction[] = []

	const prune = (now: number) => {
		while (recent.length > 0 && now - recent[0]!.atMs > windowMs)
			recent.shift()
	}

	return {
		checkAdd(senderId, messageId) {
			if (!senderId)
				return { allowed: true }

			const now = Date.now()
			prune(now)

			const prior = recent.find(entry => entry.senderId === senderId)
			if (prior && prior.messageId !== messageId) {
				return {
					allowed: false,
					reason: `Already reacted to message ${prior.messageId} from this sender recently. One reaction per burst is enough — stay silent on their other messages until the conversation moves on.`,
				}
			}

			return { allowed: true }
		},

		recordAdd(senderId, messageId) {
			if (!senderId)
				return

			const now = Date.now()
			prune(now)

			const existingIdx = recent.findIndex(entry => entry.senderId === senderId)
			if (existingIdx >= 0)
				recent.splice(existingIdx, 1)

			recent.push({ atMs: now, messageId, senderId })
		},
	}
}

export function createReactionGuardRegistry(windowMs = DEFAULT_WINDOW_MS): {
	forChat: (chatId: string) => ReactionGuard
} {
	const guards = new Map<string, ReactionGuard>()

	return {
		forChat(chatId: string) {
			let guard = guards.get(chatId)
			if (!guard) {
				guard = createReactionGuard(chatId, windowMs)
				guards.set(chatId, guard)
			}
			return guard
		},
	}
}
