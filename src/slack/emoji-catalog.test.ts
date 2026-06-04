import { describe, expect, it } from 'vitest';

import {
  parseSlackEmojiList,
  renderSlackEmojiCatalogXml,
  SLACK_STANDARD_REACTION_NAMES,
} from './emoji-catalog';

describe('parseSlackEmojiList', () => {
  it('collects all emoji keys and alias pairs', () => {
    const parsed = parseSlackEmojiList({
      party_parrot: 'https://example.com/parrot.gif',
      parrot: 'party_parrot',
    });
    expect(parsed.customNames).toEqual(['parrot', 'party_parrot']);
    expect(parsed.aliases).toEqual([{ name: 'parrot', aliasOf: 'party_parrot' }]);
    expect(parsed.totalCustom).toBe(2);
  });
});

describe('renderSlackEmojiCatalogXml', () => {
  it('includes standard and custom names', () => {
    const xml = renderSlackEmojiCatalogXml({
      customNames: ['blob_help'],
      aliases: [],
      standardReactionNames: SLACK_STANDARD_REACTION_NAMES,
      totalCustom: 1,
      truncated: false,
    });
    expect(xml).toContain('<slack-emoji-catalog>');
    expect(xml).toContain('blob_help');
    expect(xml).toContain('eyes');
    expect(xml).toContain('react_to_message');
  });

  it('surfaces load errors', () => {
    const xml = renderSlackEmojiCatalogXml({
      customNames: [],
      aliases: [],
      standardReactionNames: SLACK_STANDARD_REACTION_NAMES,
      totalCustom: 0,
      truncated: false,
      loadError: 'missing_scope',
    });
    expect(xml).toContain('emoji:read');
    expect(xml).toContain('missing_scope');
  });
});
