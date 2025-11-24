/**
 * SignalEffector - Sends agent speech facets as Signal messages
 *
 * Observes speech facets and sends them via Signal CLI REST API
 */

import axios from 'axios';
import { BaseEffector } from 'connectome-ts';
import type { EffectorResult, FacetDelta, ReadonlyVEILState } from 'connectome-ts';

export interface SignalEffectorConfig {
  apiUrl: string; // e.g., 'http://localhost:8081'
  // Map of bot phone numbers to their display names
  botNames: Map<string, string>;
  // Maximum message length before splitting
  maxMessageLength?: number;
}

/**
 * SignalSpeechEffector sends speech facets to Signal
 */
export class SignalSpeechEffector extends BaseEffector {
  private config: SignalEffectorConfig;
  private maxMessageLength: number;

  constructor(config: SignalEffectorConfig) {
    super();
    this.config = config;
    this.maxMessageLength = config.maxMessageLength || 400;
  }

  async process(changes: FacetDelta[], state: ReadonlyVEILState): Promise<EffectorResult> {
    const events = [];

    for (const change of changes) {
      if (change.type === 'added' && change.facet.type === 'speech') {
        try {
          await this.sendSpeech(change.facet, state);
        } catch (error) {
          console.error('[SignalSpeechEffector] Error sending speech:', error);
          // Emit error event
          events.push({
            topic: 'signal:send-error',
            source: { elementId: this.element?.id || 'signal-effector', elementPath: [] },
            timestamp: Date.now(),
            payload: {
              facetId: change.facet.id,
              error: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
    }

    return { events };
  }

  private async sendSpeech(facet: any, state: ReadonlyVEILState): Promise<void> {
    let content = facet.content;
    if (!content) return;

    // Strip HUD rendering tags (these are for display only, not for sending)
    // Remove all XML-like tags (<my_turn>, <event>, etc.)
    content = content.replace(/<[^>]+>/g, '').trim();

    // Strip speaker prefix (e.g., "Claude: " or "+12186633092: ")
    // The HUD may prepend speaker names to content for rendering
    content = content.replace(/^[^:]+:\s*/, '').trim();

    // Strip Object Replacement Character (U+FFFC) used for mentions
    // We're not handling mentions in responses yet, so remove these placeholder characters
    content = content.replace(/\uFFFC/g, '').trim();

    // Get stream context (check both root level and attributes)
    const streamId = facet.streamId || facet.attributes?.streamId;
    if (!streamId) {
      console.warn('[SignalSpeechEffector] Speech facet has no streamId:', facet.id);
      return;
    }

    const streamFacet = state.facets.get(streamId);
    if (!streamFacet) {
      console.warn('[SignalSpeechEffector] Stream not found:', streamId);
      return;
    }

    const conversationKey = streamFacet.attributes?.conversationKey;
    const isGroupChat = streamFacet.attributes?.isGroupChat;
    const botPhone = streamFacet.attributes?.botPhone;

    console.log(`[SignalSpeechEffector] Stream ${streamId}: conversationKey=${conversationKey}, isGroupChat=${isGroupChat}, botPhone=${botPhone}`);

    if (!conversationKey || !botPhone) {
      console.warn('[SignalSpeechEffector] Missing conversation info in stream:', streamId);
      return;
    }

    // Split message if too long
    const chunks = this.splitMessage(content);

    // Send each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const payload: any = {
        number: botPhone,
        recipients: [conversationKey],
        message: chunk,
        text_mode: 'styled' // Enable markdown formatting
      };

      // TODO: Handle attachments from facet.attributes?.attachments

      const url = `${this.config.apiUrl}/v2/send`;

      try {
        await axios.post(url, payload);

        if (chunks.length > 1) {
          console.log(`[SignalSpeechEffector] Message chunk ${i + 1}/${chunks.length} sent to ${conversationKey}`);
        } else {
          console.log(`[SignalSpeechEffector] Message sent to ${conversationKey}`);
        }
      } catch (error) {
        console.error(`[SignalSpeechEffector] Failed to send message chunk ${i + 1}:`, error);
        throw error;
      }
    }
  }

  private splitMessage(content: string): string[] {
    if (content.length <= this.maxMessageLength) {
      return [content];
    }

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= this.maxMessageLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (newline, period, space)
      let breakPoint = this.maxMessageLength;

      // Try to break at newline
      const lastNewline = remaining.lastIndexOf('\n', this.maxMessageLength);
      if (lastNewline > this.maxMessageLength * 0.7) {
        breakPoint = lastNewline + 1;
      } else {
        // Try to break at sentence end
        const lastPeriod = remaining.lastIndexOf('. ', this.maxMessageLength);
        if (lastPeriod > this.maxMessageLength * 0.7) {
          breakPoint = lastPeriod + 2;
        } else {
          // Break at space
          const lastSpace = remaining.lastIndexOf(' ', this.maxMessageLength);
          if (lastSpace > this.maxMessageLength * 0.7) {
            breakPoint = lastSpace + 1;
          }
        }
      }

      chunks.push(remaining.substring(0, breakPoint).trim());
      remaining = remaining.substring(breakPoint).trim();
    }

    return chunks;
  }
}
