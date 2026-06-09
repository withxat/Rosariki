import type { Logger } from '@guiiai/logg'

type Handler<T> = (event: T) => void

export interface EventBus<T> {
	emit: (event: T) => void
	on: (handler: Handler<T>) => void
}

export function createEventBus<T>(name: string, logger: Logger): EventBus<T> {
	const handlers: Handler<T>[] = []
	return {
		emit: (event) => {
			for (const handler of handlers) {
				try {
					handler(event)
				}
				catch (err) {
					logger.withError(err).error(`${name} handler error`)
				}
			}
		},
		on: (handler) => { handlers.push(handler) },
	}
}
