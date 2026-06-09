import { describe, expect, it } from 'vitest'

import { adaptSlackDelete, adaptSlackEdit, adaptSlackMessage, adaptSlackReaction, parseSlackContent } from './adapter'

describe('slack adapter', () => {
	it('parses Slack user mentions as canonical mention nodes', () => {
		expect(parseSlackContent('hi <@U123ABC|alice> &amp; <@U999>')).toEqual([
			{ text: 'hi ', type: 'text' },
			{ children: [{ text: '@alice', type: 'text' }], type: 'mention', userId: 'U123ABC' },
			{ text: ' & ', type: 'text' },
			{ children: [{ text: '<@U999>', type: 'text' }], type: 'mention', userId: 'U999' },
		])
	})

	it('parses Slack mrkdwn links, channels, subteams, and inline formatting', () => {
		expect(parseSlackContent('see <https://example.com|*docs*> in <#C123|general> <!subteam^S123|ops> `now`')).toEqual([
			{ text: 'see ', type: 'text' },
			{ children: [{ children: [{ text: 'docs', type: 'text' }], type: 'bold' }], type: 'link', url: 'https://example.com' },
			{ text: ' in ', type: 'text' },
			{ text: '#general', type: 'text' },
			{ text: ' ', type: 'text' },
			{ text: '@ops', type: 'text' },
			{ text: ' ', type: 'text' },
			{ text: 'now', type: 'code' },
		])
	})

	it('maps Slack files to canonical attachments', () => {
		const msg = adaptSlackMessage({
			chatId: 'C123',
			date: 1710000000,
			files: [{
				height: 600,
				id: 'F1',
				mimeType: 'image/png',
				name: 'photo.png',
				thumbnailWebp: 'AAAA',
				width: 800,
			}, {
				id: 'F2',
				mimeType: 'application/pdf',
				title: 'report.pdf',
			}],
			messageId: '1710000000.123456',
			receivedAtMs: 1710000000123,
			text: 'file',
			utcOffsetMin: 480,
		})

		expect(msg.attachments).toEqual([
			{
				fileName: 'photo.png',
				height: 600,
				mimeType: 'image/png',
				platformFileId: 'F1',
				thumbnailWebp: 'AAAA',
				type: 'photo',
				width: 800,
			},
			{
				fileName: 'report.pdf',
				mimeType: 'application/pdf',
				platformFileId: 'F2',
				type: 'document',
			},
		])
	})

	it('adapts messages, edits, and deletes with string message IDs', () => {
		const msg = adaptSlackMessage({
			chatId: 'C123',
			date: 1710000000,
			messageId: '1710000000.123456',
			receivedAtMs: 1710000000123,
			replyToMessageId: '1710000000.000001',
			sender: { displayName: 'Alice', id: 'U1', isBot: false, username: 'alice' },
			text: 'hello',
			utcOffsetMin: 480,
		})
		expect(msg).toMatchObject({
			chatId: 'C123',
			messageId: '1710000000.123456',
			replyToMessageId: '1710000000.000001',
			sender: { displayName: 'Alice', id: 'U1', isBot: false, username: 'alice' },
			type: 'message',
		})

		const edit = adaptSlackEdit({
			chatId: 'C123',
			date: 1710000000,
			editDate: 1710000005,
			files: [{ duration: 3, id: 'F3', mimeType: 'video/mp4', name: 'clip.mp4' }],
			messageId: '1710000000.123456',
			receivedAtMs: 1710000005123,
			text: 'edited',
			utcOffsetMin: 480,
		})
		expect(edit.messageId).toBe('1710000000.123456')
		expect(edit.timestampSec).toBe(1710000005)
		expect(edit.attachments).toEqual([{ duration: 3, fileName: 'clip.mp4', mimeType: 'video/mp4', platformFileId: 'F3', type: 'video' }])

		const del = adaptSlackDelete({
			chatId: 'C123',
			messageIds: ['1710000000.123456'],
			receivedAtMs: 1710000006123,
			utcOffsetMin: 480,
		})
		expect(del.messageIds).toEqual(['1710000000.123456'])
	})

	it('adapts Slack reactions as service events', () => {
		const event = adaptSlackReaction({
			chatId: 'C123',
			messageId: '1710000000.123456',
			operation: 'added',
			reaction: 'eyes',
			receivedAtMs: 1710000007123,
			sender: { displayName: 'Alice', id: 'U1', isBot: false, username: 'alice' },
			utcOffsetMin: 480,
		})

		expect(event).toMatchObject({
			action: {
				action: 'message_reaction',
				messageId: '1710000000.123456',
				operation: 'added',
				reaction: 'eyes',
			},
			actor: { displayName: 'Alice', id: 'U1', isBot: false, username: 'alice' },
			chatId: 'C123',
			type: 'service',
		})
	})
})
