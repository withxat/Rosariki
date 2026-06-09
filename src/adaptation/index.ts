export type {
	CanonicalAttachment,
	CanonicalDeleteEvent,
	CanonicalEditEvent,
	CanonicalForwardInfo,
	CanonicalIMEvent,
	CanonicalMessageEvent,
	CanonicalServiceEvent,
	CanonicalUser,
	ContentNode,
	ServiceAction,
} from './types'

export function contentToPlainText(nodes: import('./types').ContentNode[]): string {
	return nodes.map(node => 'children' in node ? contentToPlainText(node.children) : node.text).join('')
}

export const captureUtcOffset = (): number => -new Date().getTimezoneOffset()
