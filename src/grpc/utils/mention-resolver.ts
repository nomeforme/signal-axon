/**
 * Signal mention utilities
 *
 * Signal uses U+FFFC (Object Replacement Character) as placeholder for mentions.
 * The mention's position in the text corresponds to the index in the mentions array.
 */

import type { SignalMention, SignalOutgoingMention } from '../types.js';

// U+FFFC - Object Replacement Character (Signal uses this for mention placeholders)
const MENTION_PLACEHOLDER = '\uFFFC';

/**
 * Cache of name → phone mappings for outgoing mention detection
 * Signal CLI API requires phone numbers, not UUIDs
 */
const nameToPhoneCache = new Map<string, string>();

/**
 * Cache of name → UUID mappings for incoming mention resolution
 */
const nameToUuidCache = new Map<string, string>();

/**
 * Get the name → phone cache (for external population)
 */
export function getNameToPhoneCache(): Map<string, string> {
  return nameToPhoneCache;
}

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
 * @param nameToPhone - Map of name → phone number (Signal CLI API requires phone, not UUID)
 * @returns Object with processed content (FFFC placeholders) and mentions array
 */
export function detectAndConvertMentions(
  content: string,
  nameToPhone: Map<string, string>
): { content: string; mentions: SignalOutgoingMention[] } {
  const mentions: SignalOutgoingMention[] = [];

  // Sort names by length (longest first) to avoid partial matches
  const sortedNames = Array.from(nameToPhone.keys()).sort((a, b) => b.length - a.length);

  let modifiedText = content;

  for (const name of sortedNames) {
    const phone = nameToPhone.get(name);
    if (!phone) continue;

    let searchPos = 0;
    while (true) {
      // Look for @name patterns
      const pos = modifiedText.indexOf(`@${name}`, searchPos);
      if (pos === -1) break;

      const matchLength = name.length + 1; // +1 for @ symbol

      // Check word boundaries (character after the name)
      const charAfter = pos + matchLength < modifiedText.length ? modifiedText[pos + matchLength] : ' ';
      const afterOk = ' \n\t,.:;!?)\'"'.includes(charAfter);

      if (afterOk) {
        // Calculate UTF-16 position (Signal uses UTF-16 offsets)
        const utf16Start = Buffer.from(modifiedText.substring(0, pos), 'utf16le').length / 2;

        // Replace @name with Signal's object replacement character
        modifiedText = modifiedText.substring(0, pos) + MENTION_PLACEHOLDER + modifiedText.substring(pos + matchLength);

        console.log(`[MentionResolver] Creating mention for '@${name}' -> phone: ${phone} at position ${utf16Start}`);
        mentions.push({
          start: utf16Start,
          length: 1,
          author: phone
        });

        searchPos = pos + 1;
      } else {
        searchPos = pos + 1;
      }
    }
  }

  return { content: modifiedText, mentions };
}

/**
 * Strip all FFFC placeholders from content (for clean display)
 */
export function stripMentionPlaceholders(content: string): string {
  return content.replace(/\uFFFC/g, '');
}
