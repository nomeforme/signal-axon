/**
 * Signal mention utilities
 *
 * Signal uses U+FFFC (Object Replacement Character) as placeholder for mentions.
 * The mention's position in the text corresponds to the index in the mentions array.
 */

import type { SignalMention } from '../types.js';

// U+FFFC - Object Replacement Character (Signal uses this for mention placeholders)
const MENTION_PLACEHOLDER = '\uFFFC';

/**
 * Cache of name → UUID mappings for mention detection
 */
const nameToUuidCache = new Map<string, string>();

/**
 * Get the name → UUID cache (for external population)
 */
export function getNameToUuidCache(): Map<string, string> {
  return nameToUuidCache;
}

/**
 * Replace FFFC placeholders with @name format for context rendering
 *
 * @param content - Raw message content with FFFC placeholders
 * @param mentions - Array of mention objects from Signal
 * @param uuidToName - Map of UUID → display name
 */
export function replaceMentionPlaceholders(
  content: string,
  mentions: SignalMention[] | undefined,
  uuidToName: Map<string, string>
): string {
  if (!mentions || mentions.length === 0) return content;

  // Sort mentions by start position in reverse order (to not mess up positions)
  const sortedMentions = [...mentions].sort((a, b) => b.start - a.start);

  let result = content;

  for (const mention of sortedMentions) {
    const name = uuidToName.get(mention.uuid) || 'unknown';
    const placeholder = result.substring(mention.start, mention.start + mention.length);

    // Replace the placeholder (which might be FFFC or some other characters)
    result =
      result.substring(0, mention.start) +
      `@${name}` +
      result.substring(mention.start + mention.length);
  }

  return result;
}

/**
 * Detect @name patterns in speech content and convert to Signal mention format
 *
 * @param content - Speech content with @name patterns
 * @param nameToUuid - Map of name → UUID
 * @returns Object with processed content (FFFC placeholders) and mentions array
 */
export function detectAndConvertMentions(
  content: string,
  nameToUuid: Map<string, string>
): { content: string; mentions: SignalMention[] } {
  const mentions: SignalMention[] = [];

  // Pattern to match @name (word characters after @)
  const mentionPattern = /@([a-zA-Z0-9_-]+)/g;

  let result = content;
  let match;
  let offset = 0;

  // Find all @name patterns
  const matches: Array<{ fullMatch: string; name: string; index: number }> = [];
  while ((match = mentionPattern.exec(content)) !== null) {
    matches.push({
      fullMatch: match[0],
      name: match[1].toLowerCase(),
      index: match.index
    });
  }

  // Process in reverse order to maintain positions
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const uuid = nameToUuid.get(m.name);

    if (uuid) {
      // Replace @name with FFFC placeholder
      const adjustedIndex = m.index;
      result =
        result.substring(0, adjustedIndex) +
        MENTION_PLACEHOLDER +
        result.substring(adjustedIndex + m.fullMatch.length);

      // Add mention (position will be at the placeholder)
      mentions.unshift({
        start: adjustedIndex,
        length: 1,  // FFFC is 1 character
        uuid
      });
    }
  }

  return { content: result, mentions };
}

/**
 * Strip all FFFC placeholders from content (for clean display)
 */
export function stripMentionPlaceholders(content: string): string {
  return content.replace(/\uFFFC/g, '');
}
