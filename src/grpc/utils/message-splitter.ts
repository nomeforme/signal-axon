/**
 * Message splitting utilities for Signal
 *
 * Signal messages have a practical limit around 4096 characters,
 * but we split at a smaller size for readability.
 */

const DEFAULT_MAX_LENGTH = 400;  // Match Signal's practical message length

/**
 * Split a long message into chunks that fit Signal's limit
 *
 * @param content - Message content to split
 * @param maxLength - Maximum length per chunk (default 1500)
 * @returns Array of message chunks
 */
export function splitMessage(content: string, maxLength: number = DEFAULT_MAX_LENGTH): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = maxLength;

    // Try to break at paragraph
    const paragraphBreak = remaining.lastIndexOf('\n\n', maxLength);
    if (paragraphBreak > maxLength * 0.5) {
      breakPoint = paragraphBreak + 2;  // Include the double newline
    } else {
      // Try to break at sentence
      const sentenceBreaks = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
      let bestSentenceBreak = -1;

      for (const sep of sentenceBreaks) {
        const idx = remaining.lastIndexOf(sep, maxLength);
        if (idx > bestSentenceBreak && idx > maxLength * 0.3) {
          bestSentenceBreak = idx + sep.length;
        }
      }

      if (bestSentenceBreak > 0) {
        breakPoint = bestSentenceBreak;
      } else {
        // Try to break at word boundary
        const spaceBreak = remaining.lastIndexOf(' ', maxLength);
        if (spaceBreak > maxLength * 0.3) {
          breakPoint = spaceBreak + 1;
        }
        // Otherwise break at maxLength
      }
    }

    chunks.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks.filter(chunk => chunk.length > 0);
}

/**
 * Add continuation markers to split messages
 *
 * @param chunks - Array of message chunks
 * @returns Chunks with continuation markers
 */
export function addContinuationMarkers(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;

  return chunks.map((chunk, i) => {
    if (i < chunks.length - 1) {
      return chunk + '\n\n[...]';
    }
    return chunk;
  });
}
