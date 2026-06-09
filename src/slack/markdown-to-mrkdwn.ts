import { slackifyMarkdown } from 'slackify-markdown'

const SPOILER_RE = /\|\|([^|\n]+)\|\|/g

// Slack mrkdwn has no spoiler; map primary-system ||spoiler|| to italic.
function markdownSpoilersToItalic(text: string): string {
	return text.replace(SPOILER_RE, '_$1_')
}

// Model output is Markdown (primary-system prompt); Slack chat.postMessage expects legacy mrkdwn.
export function markdownToMrkdwn(text: string): string {
	if (!text)
		return text
	return slackifyMarkdown(markdownSpoilersToItalic(text)).replace(/\n+$/, '')
}
