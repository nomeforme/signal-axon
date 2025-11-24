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

// Helper to create reverse map (name -> phone)
function createNameToPhoneMap(botNames: Map<string, string>): Map<string, string> {
  const nameToPhone = new Map<string, string>();
  for (const [phone, name] of botNames) {
    nameToPhone.set(name, phone);
  }
  return nameToPhone;
}

/**
 * SignalSpeechEffector sends speech facets to Signal
 */
export class SignalSpeechEffector extends BaseEffector {
  private config: SignalEffectorConfig;
  private maxMessageLength: number;
  private groupIdCache = new Map<string, string>(); // Cache internal_id -> external id mappings
  private nameToPhone: Map<string, string>; // Reverse map: bot name -> phone number

  constructor(config: SignalEffectorConfig) {
    super();
    this.config = config;
    this.maxMessageLength = config.maxMessageLength || 400;
    this.nameToPhone = createNameToPhoneMap(config.botNames);
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

  /**
   * Convert internal group ID to external group ID that the API expects
   * Signal provides internal_id in WebSocket messages, but /v2/send requires the external id
   */
  private async convertGroupId(internalId: string, botPhone: string): Promise<string | null> {
    // Check cache first
    const cached = this.groupIdCache.get(internalId);
    if (cached) {
      return cached;
    }

    // Fetch groups list from API
    const url = `${this.config.apiUrl}/v1/groups/${botPhone}`;
    try {
      const response = await axios.get(url);
      const groups = response.data;

      // Find the group with matching internal_id
      for (const group of groups) {
        if (group.internal_id === internalId) {
          // Cache the mapping
          this.groupIdCache.set(internalId, group.id);
          console.log(`[SignalSpeechEffector] Converted group ID: ${internalId.substring(0, 20)}... -> ${group.id}`);
          return group.id;
        }
      }

      console.warn(`[SignalSpeechEffector] No external group ID found for internal_id: ${internalId}`);
      return null;
    } catch (error) {
      console.error(`[SignalSpeechEffector] Error fetching groups for ${botPhone}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
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
    let botPhone = streamFacet.attributes?.botPhone;

    // For group chats, the stream is shared among all bots, so we need to determine
    // which bot should send this response based on the agentId
    if (isGroupChat && facet.agentId) {
      // agentId is like "agent-haiku-4-5" - extract the bot name
      const agentIdStr = String(facet.agentId);
      const botName = agentIdStr.startsWith('agent-') ? agentIdStr.slice(6) : agentIdStr;
      const phoneFromAgent = this.nameToPhone.get(botName);
      if (phoneFromAgent) {
        console.log(`[SignalSpeechEffector] Group chat: using phone ${phoneFromAgent} for agent ${botName}`);
        botPhone = phoneFromAgent;
      } else {
        console.warn(`[SignalSpeechEffector] Could not find phone for agent ${botName}, falling back to stream botPhone`);
      }
    }

    console.log(`[SignalSpeechEffector] Stream ${streamId}: conversationKey=${conversationKey}, isGroupChat=${isGroupChat}, botPhone=${botPhone}, agentId=${facet.agentId}`);

    if (!conversationKey || !botPhone) {
      console.warn('[SignalSpeechEffector] Missing conversation info in stream:', streamId);
      return;
    }

    // For group chats, convert internal group ID to external group ID
    let recipientId = conversationKey;
    if (isGroupChat) {
      const externalGroupId = await this.convertGroupId(conversationKey, botPhone);
      if (externalGroupId) {
        recipientId = externalGroupId;
      } else {
        console.warn(`[SignalSpeechEffector] Failed to convert group ID, falling back to internal ID: ${conversationKey}`);
        // Fall back to using internal ID (may fail, but better than not trying)
      }
    }

    // Split message if too long
    const chunks = this.splitMessage(content);

    // Send each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const payload: any = {
        number: botPhone,
        recipients: [recipientId],
        message: chunk,
        text_mode: 'styled' // Enable markdown formatting
      };

      // TODO: Handle attachments from facet.attributes?.attachments

      const url = `${this.config.apiUrl}/v2/send`;

      try {
        await axios.post(url, payload);

        if (chunks.length > 1) {
          console.log(`[SignalSpeechEffector] Message chunk ${i + 1}/${chunks.length} sent to ${recipientId}`);
        } else {
          console.log(`[SignalSpeechEffector] Message sent to ${recipientId}`);
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
