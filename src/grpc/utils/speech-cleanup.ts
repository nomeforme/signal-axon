/**
 * Speech content cleanup utilities
 *
 * Cleans up LLM output for Signal display:
 * - Removes XML-style tags
 * - Extracts tool use syntax
 * - Normalizes whitespace
 */

/**
 * Clean speech content for Signal output
 *
 * @param content - Raw speech content from LLM
 * @returns Cleaned content suitable for Signal
 */
export function cleanSpeechContent(content: string): string {
  if (!content) return '';

  let cleaned = content;

  // Remove XML-style wrapper tags (like <response>, <reply>, etc.)
  cleaned = cleaned.replace(/<\/?(?:response|reply|message|output|answer|thinking|thought|inner_monologue)[^>]*>/gi, '');

  // Remove action tags but keep content
  cleaned = cleaned.replace(/<action[^>]*>([\s\S]*?)<\/action>/gi, '$1');

  // Remove tool result wrappers
  cleaned = cleaned.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/gi, '');

  // Remove thinking/reasoning blocks entirely
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  cleaned = cleaned.replace(/<reflection>[\s\S]*?<\/reflection>/gi, '');

  // Remove my_turn and other turn markers
  cleaned = cleaned.replace(/<\/?(?:my_turn|their_turn|turn)[^>]*>/gi, '');

  // Clean up excessive whitespace
  cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');  // Max 3 newlines
  cleaned = cleaned.replace(/[ \t]+/g, ' ');  // Collapse horizontal whitespace
  cleaned = cleaned.replace(/\n[ \t]+/g, '\n');  // Remove leading whitespace on lines
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n');  // Remove trailing whitespace on lines

  // Trim
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Extract any tool use from content (for logging)
 *
 * @param content - Raw content
 * @returns Object with toolCalls and cleanedContent
 */
export function extractToolUse(content: string): {
  toolCalls: Array<{ name: string; input: string }>;
  cleanedContent: string;
} {
  const toolCalls: Array<{ name: string; input: string }> = [];

  // Match tool_use blocks
  const toolUsePattern = /<tool_use>\s*<name>(.*?)<\/name>\s*<input>([\s\S]*?)<\/input>\s*<\/tool_use>/gi;
  let match;

  while ((match = toolUsePattern.exec(content)) !== null) {
    toolCalls.push({
      name: match[1].trim(),
      input: match[2].trim()
    });
  }

  // Remove tool_use blocks from content
  const cleanedContent = content.replace(toolUsePattern, '').trim();

  return { toolCalls, cleanedContent };
}
