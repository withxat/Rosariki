import type { Logger } from '@guiiai/logg';
import type { WebClient } from '@slack/web-api';

/** Slack built-in reaction names (emoji.list only returns workspace custom emoji). */
export const SLACK_STANDARD_REACTION_NAMES = [
  '+1', '-1', '100', '1234', 'eyes', 'eye', 'thumbsup', 'thumbsdown', 'heart',
  'blue_heart', 'green_heart', 'yellow_heart', 'orange_heart', 'purple_heart',
  'black_heart', 'white_heart', 'broken_heart', 'joy', 'sob', 'cry', 'rage',
  'angry', 'smile', 'laughing', 'sweat_smile', 'rofl', 'thinking_face', 'exploding_head',
  'fire', 'tada', 'clap', 'pray', 'wave', 'ok_hand', 'raised_hands', 'muscle',
  'white_check_mark', 'heavy_check_mark', 'x', 'warning', 'question', 'exclamation',
  'bulb', 'rocket', 'star', 'sparkles', 'zzz', 'coffee', 'beer', 'cake', 'pizza',
  'dog', 'cat', 'skull', 'ghost', 'alien', 'robot_face', 'sunglasses', 'cool',
  'hot_face', 'cold_face', 'melting_face', 'saluting_face', 'facepalm', 'shrug',
] as const;

const MAX_CUSTOM_NAMES_IN_PROMPT = 400;

export interface SlackEmojiAlias {
  name: string;
  aliasOf: string;
}

export interface SlackEmojiCatalog {
  customNames: string[];
  aliases: SlackEmojiAlias[];
  standardReactionNames: readonly string[];
  totalCustom: number;
  truncated: boolean;
  loadError?: string;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isImageUrl = (value: string): boolean =>
  value.startsWith('http://') || value.startsWith('https://');

/** Parse emoji.list: each key is a valid :name: / reaction name; non-URL values are aliases. */
export const parseSlackEmojiList = (emoji: Record<string, string> | undefined): Pick<SlackEmojiCatalog, 'customNames' | 'aliases' | 'totalCustom'> => {
  if (!emoji) return { customNames: [], aliases: [], totalCustom: 0 };

  const aliases: SlackEmojiAlias[] = [];
  const customNames: string[] = [];

  for (const [name, value] of Object.entries(emoji)) {
    if (!name) continue;
    customNames.push(name);
    if (!isImageUrl(value))
      aliases.push({ name, aliasOf: value });
  }

  customNames.sort((a, b) => a.localeCompare(b));
  return { customNames, aliases, totalCustom: customNames.length };
};

export const fetchSlackEmojiCatalog = async (
  client: WebClient,
  log: Logger,
): Promise<SlackEmojiCatalog> => {
  const base: SlackEmojiCatalog = {
    customNames: [],
    aliases: [],
    standardReactionNames: SLACK_STANDARD_REACTION_NAMES,
    totalCustom: 0,
    truncated: false,
  };

  try {
    const result = await client.emoji.list();
    const parsed = parseSlackEmojiList(result.emoji as Record<string, string> | undefined);
    const truncated = parsed.customNames.length > MAX_CUSTOM_NAMES_IN_PROMPT;
    return {
      ...base,
      customNames: parsed.customNames.slice(0, MAX_CUSTOM_NAMES_IN_PROMPT),
      aliases: parsed.aliases.slice(0, 100),
      totalCustom: parsed.totalCustom,
      truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.withError(err).warn('emoji.list failed — custom emoji names unavailable (needs emoji:read scope)');
    return { ...base, loadError: message };
  }
};

export const renderSlackEmojiCatalogXml = (catalog: SlackEmojiCatalog): string => {
  const lines = [
    '<slack-emoji-catalog>',
    '<usage>',
    'react_to_message: use bare names without colons (e.g. eyes, thumbsup, party_parrot).',
    'send_message mrkdwn: use :name: for workspace custom emoji; Unicode emoji work as literal characters.',
    'message_reaction events in context use the same bare names.',
    '</usage>',
    `<standard-reaction-names count="${catalog.standardReactionNames.length}">${catalog.standardReactionNames.join(', ')}</standard-reaction-names>`,
  ];

  if (catalog.loadError) {
    lines.push(`<custom-emoji-warning>emoji.list failed: ${escapeXml(catalog.loadError)}. Only standard reaction names are listed above. Grant the bot emoji:read scope for workspace custom emoji.</custom-emoji-warning>`);
  } else if (catalog.customNames.length === 0) {
    lines.push('<custom-emoji-names count="0">(none returned)</custom-emoji-names>');
  } else {
    const truncNote = catalog.truncated
      ? ` showing ${catalog.customNames.length} of ${catalog.totalCustom}`
      : '';
    lines.push(
      `<custom-emoji-names count="${catalog.totalCustom}"${catalog.truncated ? ' truncated="true"' : ''}${truncNote}>`,
      escapeXml(catalog.customNames.join(', ')),
      '</custom-emoji-names>',
    );
  }

  if (catalog.aliases.length > 0) {
    const aliasLines = catalog.aliases.map(a => `${a.name}→${a.aliasOf}`).join(', ');
    lines.push(`<custom-emoji-aliases>${escapeXml(aliasLines)}</custom-emoji-aliases>`);
  }

  lines.push('</slack-emoji-catalog>');
  return lines.join('\n');
};
