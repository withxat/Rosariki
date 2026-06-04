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
      receivedAtMs: 1710000005123,
      utcOffsetMin: 480,
    });
    expect(edit.messageId).toBe('1710000000.123456');
    expect(edit.timestampSec).toBe(1710000005);

    const del = adaptSlackDelete({
      chatId: 'C123',
      messageIds: ['1710000000.123456'],
      receivedAtMs: 1710000006123,
      utcOffsetMin: 480,
    });
    expect(del.messageIds).toEqual(['1710000000.123456']);
  });
});
