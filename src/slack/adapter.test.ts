import { describe, expect, it } from 'vitest';

import { adaptSlackDelete, adaptSlackEdit, adaptSlackMessage, parseSlackContent } from './adapter';

describe('Slack adapter', () => {
  it('parses Slack user mentions as canonical mention nodes', () => {
    expect(parseSlackContent('hi <@U123ABC|alice> &amp; <@U999>')).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'mention', userId: 'U123ABC', children: [{ type: 'text', text: '@alice' }] },
      { type: 'text', text: ' & ' },
      { type: 'mention', userId: 'U999', children: [{ type: 'text', text: '<@U999>' }] },
    ]);
  });

  it('parses Slack mrkdwn links, channels, subteams, and inline formatting', () => {
    expect(parseSlackContent('see <https://example.com|*docs*> in <#C123|general> <!subteam^S123|ops> `now`')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', url: 'https://example.com', children: [{ type: 'bold', children: [{ type: 'text', text: 'docs' }] }] },
      { type: 'text', text: ' in ' },
      { type: 'text', text: '#general' },
      { type: 'text', text: ' ' },
      { type: 'text', text: '@ops' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'now' },
    ]);
  });

  it('maps Slack files to canonical attachments', () => {
    const msg = adaptSlackMessage({
      chatId: 'C123',
      messageId: '1710000000.123456',
      date: 1710000000,
      text: 'file',
      files: [{
        id: 'F1',
        name: 'photo.png',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        thumbnailWebp: 'AAAA',
      }, {
        id: 'F2',
        title: 'report.pdf',
        mimeType: 'application/pdf',
      }],
      receivedAtMs: 1710000000123,
      utcOffsetMin: 480,
    });

    expect(msg.attachments).toEqual([
      {
        type: 'photo',
        mimeType: 'image/png',
        fileName: 'photo.png',
        width: 800,
        height: 600,
        thumbnailWebp: 'AAAA',
      },
      {
        type: 'document',
        mimeType: 'application/pdf',
        fileName: 'report.pdf',
      },
    ]);
  });

  it('adapts messages, edits, and deletes with string message IDs', () => {
    const msg = adaptSlackMessage({
      chatId: 'C123',
      messageId: '1710000000.123456',
      date: 1710000000,
      text: 'hello',
      replyToMessageId: '1710000000.000001',
      sender: { id: 'U1', displayName: 'Alice', username: 'alice', isBot: false },
      receivedAtMs: 1710000000123,
      utcOffsetMin: 480,
    });
    expect(msg).toMatchObject({
      type: 'message',
      chatId: 'C123',
      messageId: '1710000000.123456',
      replyToMessageId: '1710000000.000001',
      sender: { id: 'U1', displayName: 'Alice', username: 'alice', isBot: false },
    });

    const edit = adaptSlackEdit({
      chatId: 'C123',
      messageId: '1710000000.123456',
      date: 1710000000,
      editDate: 1710000005,
      text: 'edited',
      files: [{ id: 'F3', name: 'clip.mp4', mimeType: 'video/mp4', duration: 3 }],
      receivedAtMs: 1710000005123,
      utcOffsetMin: 480,
    });
    expect(edit.messageId).toBe('1710000000.123456');
    expect(edit.timestampSec).toBe(1710000005);
    expect(edit.attachments).toEqual([{ type: 'video', mimeType: 'video/mp4', fileName: 'clip.mp4', duration: 3 }]);

    const del = adaptSlackDelete({
      chatId: 'C123',
      messageIds: ['1710000000.123456'],
      receivedAtMs: 1710000006123,
      utcOffsetMin: 480,
    });
    expect(del.messageIds).toEqual(['1710000000.123456']);
  });
});
