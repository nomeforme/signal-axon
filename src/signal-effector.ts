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

// Mention structure for Signal API
interface SignalMention {
  start: number;
  length: number;
  author: string; // phone number
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

    console.log(`[SignalSpeechEffector] Original content (first 100 chars): "${content.substring(0, 100)}"`);
    console.log(`[SignalSpeechEffector] Facet agentName: ${facet.agentName}, agentId: ${facet.agentId}`);

    // Strip speaker prefix (e.g., "haiku-4-5: " or "sonnet-4-5: ")
    // The prefix is added by SpeakerPrefixReceptor for internal identification
    content = content.replace(/^[^:]+:\s*/, '').trim();

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

    // Detect mentions in text (only for group chats)
    let processedContent = content;
    let mentions: SignalMention[] = [];
    if (isGroupChat) {
      const result = this.detectMentions(content, state);
      processedContent = result.text;
      mentions = result.mentions;
      if (mentions.length > 0) {
        console.log(`[SignalSpeechEffector] Detected ${mentions.length} mentions in message`);
      }
    }

    // Split message if too long
    const chunks = this.splitMessage(processedContent);

    // Send each chunk (only first chunk gets mentions to avoid duplicate notifications)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const payload: any = {
        number: botPhone,
        recipients: [recipientId],
        message: chunk,
        text_mode: 'styled' // Enable markdown formatting
      };

      // Add mentions only to the first chunk
      if (i === 0 && mentions.length > 0) {
        payload.mentions = mentions;
      }

      // TODO: Handle attachments from facet.attributes?.attachments

      const url = `${this.config.apiUrl}/v2/send`;

      try {
        await axios.post(url, payload);

        if (chunks.length > 1) {
          console.log(`[SignalSpeechEffector] Message chunk ${i + 1}/${chunks.length} sent to ${recipientId}`);
        } else {
          console.log(`[SignalSpeechEffector] Message sent to ${recipientId}${mentions.length > 0 ? ` with ${mentions.length} mentions` : ''}`);
        }
      } catch (error) {
        console.error(`[SignalSpeechEffector] Failed to send message chunk ${i + 1}:`, error);
        throw error;
      }
    }
  }

  /**
   * Detect @mentions in text and convert to Signal mention format
   * Looks for bot names and user display names, replaces with U+FFFC placeholder
   */
  private detectMentions(text: string, state: ReadonlyVEILState): { text: string; mentions: SignalMention[] } {
    const mentions: SignalMention[] = [];
    let modifiedText = text;

    // Build name -> phone mapping from bot names
    const nameToPhone = new Map<string, string>();
    for (const [phone, name] of this.config.botNames) {
      nameToPhone.set(name, phone);
    }

    // Add user display names from user-profile facets
    for (const facet of state.facets.values()) {
      if (facet.type === 'user-profile') {
        const displayName = facet.attributes?.displayName || facet.content;
        const phone = facet.attributes?.phoneNumber;
        if (displayName && phone) {
          nameToPhone.set(displayName, phone);
        }
      }
    }

    // Sort names by length (longest first) to avoid partial matches
    const sortedNames = Array.from(nameToPhone.keys()).sort((a, b) => b.length - a.length);

    for (const name of sortedNames) {
      const phone = nameToPhone.get(name);
      if (!phone) continue;

      let searchPos = 0;
      while (true) {
        // ONLY look for @name patterns - NOT bare names
        // Bare names like "3-7-sonnet:" at the start are speaker prefixes, not mentions
        const pos = modifiedText.indexOf(`@${name}`, searchPos);

        if (pos === -1) break;

        const matchLength = name.length + 1; // +1 for @ symbol

        // Check word boundaries (character after the name)
        const charAfter = pos + matchLength < modifiedText.length ? modifiedText[pos + matchLength] : ' ';
        const afterOk = ' \n\t,.:;!?'.includes(charAfter);

        if (afterOk) {
          // Calculate UTF-16 position (Signal uses UTF-16 offsets)
          const utf16Start = Buffer.from(modifiedText.substring(0, pos), 'utf16le').length / 2;

          // Replace @name with Signal's object replacement character
          const replacement = '\uFFFC';
          modifiedText = modifiedText.substring(0, pos) + replacement + modifiedText.substring(pos + matchLength);

          console.log(`[SignalSpeechEffector] Creating mention for '@${name}' -> phone: ${phone} at position ${utf16Start}`);
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

    return { text: modifiedText, mentions };
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

/**
 * Callback type for updating config values
 */
export type ConfigUpdateCallback = (updates: { randomReplyChance?: number; maxBotMentionsPerConversation?: number; maxConversationFrames?: number; maxMemoryFrames?: number }) => void;

/**
 * SignalCommandEffector handles command facets (!rr, !bb, !help)
 * and sends responses via Signal
 */
export class SignalCommandEffector extends BaseEffector {
  private config: SignalEffectorConfig;
  private onConfigUpdate?: ConfigUpdateCallback;
  private groupIdCache = new Map<string, string>(); // Cache internal_id -> external id mappings

  constructor(config: SignalEffectorConfig, onConfigUpdate?: ConfigUpdateCallback) {
    super();
    this.config = config;
    this.onConfigUpdate = onConfigUpdate;
  }

  /**
   * Convert internal group ID to external group ID that the API expects
   */
  private async convertGroupId(internalId: string, botPhone: string): Promise<string | null> {
    const cached = this.groupIdCache.get(internalId);
    if (cached) return cached;

    const url = `${this.config.apiUrl}/v1/groups/${botPhone}`;
    try {
      const response = await axios.get(url);
      const groups = response.data;

      for (const group of groups) {
        if (group.internal_id === internalId) {
          this.groupIdCache.set(internalId, group.id);
          return group.id;
        }
      }
      return null;
    } catch (error) {
      console.error(`[SignalCommandEffector] Error fetching groups:`, error);
      return null;
    }
  }

  async process(changes: FacetDelta[], state: ReadonlyVEILState): Promise<EffectorResult> {
    for (const change of changes) {
      if (change.type === 'added' && change.facet.type === 'signal-command') {
        try {
          await this.handleCommand(change.facet, state);
        } catch (error) {
          console.error('[SignalCommandEffector] Error handling command:', error);
        }
      }
    }

    return { events: [] };
  }

  private async handleCommand(facet: any, state: ReadonlyVEILState): Promise<void> {
    const { command, args, botPhone, source, groupId, currentConfig } = facet.state;

    console.log(`[SignalCommandEffector] Handling command: ${command} ${args}`);

    let response = '';
    let configUpdates: { randomReplyChance?: number; maxBotMentionsPerConversation?: number; maxConversationFrames?: number; maxMemoryFrames?: number } | null = null;

    switch (command) {
      case '!help':
        response = `📋 *Available Commands*

!rr [number] - Random reply chance
  • 0 = disabled
  • 1 = 100% (reply to every message)
  • 10 = 10%, 100 = 1%, etc.
  • No argument shows current setting

!bb [number] - Bot-to-bot mention limit
  • Max mentions before requiring human message
  • 0 = disabled, 1+ = limit
  • No argument shows current setting

!mcf [number] - Max context frames
  • Rolling window for context
  • No argument shows current setting

!mmf [number] - Max memory frames
  • Frames kept in RAM (rest on disk)
  • No argument shows current setting

!help - Show this message`;
        break;

      case '!rr':
        if (!args) {
          // Show current setting
          const chance = currentConfig.randomReplyChance;
          if (chance === 0) {
            response = 'Random reply is currently disabled (0)';
          } else {
            const percentage = (100 / chance).toFixed(1);
            response = `Random reply: 1/${chance} (${percentage}%)`;
          }
        } else {
          const newChance = parseInt(args);
          if (isNaN(newChance) || newChance < 0) {
            response = '❌ Invalid value. Use a number >= 0 (0 = disabled, 1 = 100%, 10 = 10%, etc.)';
          } else {
            configUpdates = { randomReplyChance: newChance };
            if (newChance === 0) {
              response = '✅ Random reply disabled';
            } else if (newChance === 1) {
              response = '✅ Random reply set to 1/1 (100%) - bots will reply to every message';
            } else {
              const percentage = (100 / newChance).toFixed(1);
              response = `✅ Random reply set to 1/${newChance} (${percentage}%)`;
            }
          }
        }
        break;

      case '!bb':
        if (!args) {
          // Show current setting
          const limit = currentConfig.maxBotMentionsPerConversation;
          if (limit === 0) {
            response = 'Bot-to-bot mentions are currently disabled (0)';
          } else {
            response = `Bot-to-bot mention limit: ${limit}`;
          }
        } else {
          const newLimit = parseInt(args);
          if (isNaN(newLimit) || newLimit < 0) {
            response = '❌ Invalid value. Use a number >= 0 (0 = disabled)';
          } else {
            configUpdates = { maxBotMentionsPerConversation: newLimit };
            if (newLimit === 0) {
              response = '✅ Bot-to-bot mentions disabled';
            } else {
              response = `✅ Bot-to-bot mention limit set to ${newLimit}`;
            }
          }
        }
        break;

      case '!mcf':
        if (!args) {
          // Show current setting
          const maxFrames = currentConfig.maxConversationFrames;
          const totalFrames = currentConfig.currentFrameCount ?? 0;
          const displayFrames = Math.min(totalFrames, maxFrames);
          response = `Frames: ${displayFrames} / ${maxFrames}`;
        } else {
          const newMaxFrames = parseInt(args);
          if (isNaN(newMaxFrames) || newMaxFrames < 100) {
            response = '❌ Invalid value. Use a number >= 100';
          } else {
            configUpdates = { maxConversationFrames: newMaxFrames };
            response = `✅ Max frames set to ${newMaxFrames}`;
          }
        }
        break;

      case '!mmf':
        if (!args) {
          // Show current setting
          const maxMemFrames = currentConfig.maxMemoryFrames;
          const totalFrames = currentConfig.currentFrameCount ?? 0;
          const displayFrames = Math.min(totalFrames, maxMemFrames);
          response = `Memory frames: ${displayFrames} / ${maxMemFrames}`;
        } else {
          const newMaxMemFrames = parseInt(args);
          if (isNaN(newMaxMemFrames) || newMaxMemFrames < 100) {
            response = '❌ Invalid value. Use a number >= 100';
          } else {
            configUpdates = { maxMemoryFrames: newMaxMemFrames };
            response = `✅ Max memory frames set to ${newMaxMemFrames}`;
          }
        }
        break;

      default:
        response = `Unknown command: ${command}. Use !help for available commands.`;
    }

    // Update config if needed
    if (configUpdates && this.onConfigUpdate) {
      this.onConfigUpdate(configUpdates);
    }

    // Send response
    await this.sendResponse(response, botPhone, source, groupId);
  }

  private async sendResponse(message: string, botPhone: string, source: string, groupId?: string): Promise<void> {
    // For group chats, convert internal group ID to external group ID
    let recipientId = source;
    if (groupId) {
      const externalGroupId = await this.convertGroupId(groupId, botPhone);
      if (externalGroupId) {
        recipientId = externalGroupId;
      } else {
        console.warn(`[SignalCommandEffector] Failed to convert group ID, using internal ID`);
        recipientId = groupId;
      }
    }

    const payload: any = {
      number: botPhone,
      recipients: [recipientId],
      message,
      text_mode: 'styled'
    };

    const url = `${this.config.apiUrl}/v2/send`;

    try {
      await axios.post(url, payload);
      console.log(`[SignalCommandEffector] Response sent to ${recipientId}`);
    } catch (error) {
      console.error(`[SignalCommandEffector] Failed to send response:`, error);
    }
  }
}
