import { describe, expect, it } from 'vitest';

import { contentToPlainText } from './index';

describe('contentToPlainText', () => {
  it('flattens nested content nodes', () => {
    expect(contentToPlainText([{ type: 'text', text: 'hello' }])).toBe('hello');
    expect(contentToPlainText([
      { type: 'bold', children: [{ type: 'text', text: 'hi' }] },
      { type: 'text', text: ' there' },
    ])).toBe('hi there');
    expect(contentToPlainText([])).toBe('');
  });
});
