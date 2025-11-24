/**
 * SignalReceptor - Converts Signal events into VEIL facets
 *
 * Pure function that transforms incoming Signal message events into
 * facets representing conversations, messages, and agent activations.
 */

import { BaseReceptor } from 'connectome-ts';
import type { SpaceEvent, VEILDelta, ReadonlyVEILState } from 'connectome-ts';

export interface SignalReceptorConfig {
  // Map of bot phone numbers to their UUIDs
  botUuids: Map<string, string>;
  // Map of bot phone numbers to their names
  botNames: Map<string, string>;
  // Group chat privacy mode: 'opt-in' (only respond when mentioned) or 'opt-out' (always respond unless opted out)
  groupPrivacyMode?: 'opt-in' | 'opt-out';
  // Random reply chance (0-100): percentage chance to randomly reply in group chats
  randomReplyChance?: number;
  // Maximum bot mentions allowed per conversation before requiring explicit mention
  maxBotMentionsPerConversation?: number;
}

/**
 * SignalMessageReceptor processes signal:message events and creates facets
 */
export class SignalMessageReceptor extends BaseReceptor {
  topics = ['signal:message'];

  private config: SignalReceptorConfig;

  constructor(config: SignalReceptorConfig) {
    super();
    this.config = config;
  }

  transform(event: SpaceEvent, state: ReadonlyVEILState): VEILDelta[] {
    const payload = event.payload as any;
    const {
      botPhone,
      source,
      sourceUuid,
      groupId,
      message,
      attachments,
      mentions,
      quote,
      timestamp
    } = payload;

    console.log(`[SignalMessageReceptor] Processing message from ${source}: "${message}" (botPhone: ${botPhone})`);

    const deltas: VEILDelta[] = [];

    // Check if this message is from a bot
    const isBotMessage = this.config.botUuids.has(source) ||
                         (sourceUuid && Array.from(this.config.botUuids.values()).includes(sourceUuid));

    if (isBotMessage) {
      // Skip bot messages - they'll be handled by agent facets
      return [];
    }

    // Determine conversation key
    const conversationKey = groupId || source;
    const isGroupChat = !!groupId;
    // For DMs, include botPhone in streamId so each bot has its own stream with the user
    // For groups, just use the groupId since all bots share the same group conversation
    const streamId = isGroupChat
      ? `signal-stream-${conversationKey}`
      : `signal-stream-${botPhone}-${conversationKey}`;

    // Check if message already exists (deduplication)
    const messageId = `signal-msg-${source}-${timestamp}`;
    const existingMessage = state.facets.get(messageId);
    if (existingMessage) {
      return []; // Already processed
    }

    // Extract display name from existing state or use phone/uuid
    let displayName = source;

    // Look up cached display name from VEIL state
    const profileFacet = Array.from(state.facets.values())
      .find(f => f.type === 'user-profile' &&
                 (f.attributes?.phoneNumber === source || f.attributes?.uuid === sourceUuid));
    if (profileFacet?.attributes?.displayName) {
      displayName = profileFacet.attributes.displayName;
    } else if (profileFacet?.content) {
      displayName = profileFacet.content;
    }

    // Check if bot was mentioned
    const botUuid = this.config.botUuids.get(botPhone);
    const botMentioned = mentions?.some((m: any) => m.uuid === botUuid) || false;
    const quotedBot = quote?.authorUuid === botUuid;

    // Determine if bot should respond based on privacy mode and random chance
    let shouldRespond = false;

    if (!isGroupChat) {
      // Always respond in DMs
      shouldRespond = true;
    } else {
      // Group chat logic
      const groupPrivacyMode = this.config.groupPrivacyMode || 'opt-in';
      const randomReplyChance = this.config.randomReplyChance || 0;

      if (botMentioned || quotedBot) {
        // Always respond when explicitly mentioned or quoted
        shouldRespond = true;
      } else if (groupPrivacyMode === 'opt-out') {
        // In opt-out mode, respond by default unless user has opted out
        // Check for opt-out status in VEIL state
        const userPrefs = Array.from(state.facets.values())
          .find(f => f.type === 'user-preferences' &&
                     f.attributes?.userId === source &&
                     f.attributes?.conversationKey === conversationKey &&
                     f.attributes?.botPhone === botPhone);

        const hasOptedOut = userPrefs?.attributes?.optedOut === true;
        shouldRespond = !hasOptedOut;
      } else if (randomReplyChance > 0) {
        // Random reply chance (0-100)
        const roll = Math.random() * 100;
        shouldRespond = roll < randomReplyChance;
      }

      // Check max bot mentions per conversation
      // If maxBotMentionsPerConversation is set, count bot responses in this conversation
      // and require explicit mention after threshold is reached
      if (shouldRespond && this.config.maxBotMentionsPerConversation) {
        const botResponseCount = Array.from(state.facets.values())
          .filter(f => f.type === 'speech' &&
                       f.aspects?.agentGenerated &&
                       f.attributes?.streamId === `signal-stream-${conversationKey}` &&
                       f.attributes?.botPhone === botPhone)
          .length;

        if (botResponseCount >= this.config.maxBotMentionsPerConversation) {
          // Require explicit mention or quote after threshold
          if (!botMentioned && !quotedBot) {
            shouldRespond = false;
          }
        }
      }
    }

    // Create speech facet as nested child (matching Discord pattern)
    const speechFacet: any = {
      id: `speech-${messageId}`,
      type: 'speech',
      content: message,
      streamId,
      state: {
        speakerId: `signal:${sourceUuid || source}`,
        speaker: displayName
      }
    };

    // Create message event facet (container for metadata)
    deltas.push({
      type: 'addFacet',
      facet: {
        id: messageId,
        type: 'event',
        // No content - content is in the nested speech facet
        displayName: displayName,
        streamId,
        aspects: {
          temporal: 'persistent'
        },
        state: {
          source: displayName,
          eventType: 'signal:message',
          metadata: {
            source,
            sourceUuid,
            conversationKey,
            isGroupChat,
            botPhone,
            timestamp
          }
        },
        attributes: {
          source,
          sourceUuid,
          conversationKey,
          isGroupChat,
          botPhone,
          timestamp,
          mentions,
          quote,
          attachments: attachments?.map((a: any) => ({
            contentType: a.contentType,
            filename: a.filename,
            id: a.id
          }))
        },
        children: [speechFacet] // Speech nested inside message
      }
    });

    // Create user-profile facet if this is the first time we've seen this user
    if (!profileFacet && source !== botPhone) {
      const profileId = `signal-profile-${sourceUuid || source}`;
      deltas.push({
        type: 'addFacet',
        facet: {
          id: profileId,
          type: 'user-profile',
          content: displayName,
          aspects: {
            hasState: true,
            temporal: 'persistent'
          },
          attributes: {
            phoneNumber: source,
            uuid: sourceUuid,
            displayName: displayName,
            platform: 'signal'
          }
        }
      });
    }

    // Create stream reference for this conversation if it doesn't exist
    const existingStream = state.facets.get(streamId);

    if (!existingStream) {
      deltas.push({
        type: 'addFacet',
        facet: {
          id: streamId,
          type: 'stream-definition',
          content: isGroupChat ? `Group ${groupId?.substring(0, 20)}...` : `DM with ${displayName}`,
          aspects: {
            hasState: true,
            temporal: 'persistent'
          },
          attributes: {
            streamType: 'signal',
            conversationKey,
            isGroupChat,
            botPhone
          }
        }
      });
    }

    // Create agent activation if bot should respond
    if (shouldRespond || !isGroupChat) {
      // Get target agent name for this bot (matches the agent's config.name)
      const botName = this.config.botNames.get(botPhone);

      console.log(`[SignalMessageReceptor] Creating agent-activation for botPhone ${botPhone}, targetAgent: ${botName}, streamId: ${streamId}, reason: ${botMentioned ? 'mention' : quotedBot ? 'quote' : 'dm'}`);

      deltas.push({
        type: 'addFacet',
        facet: {
          id: `signal-activation-${timestamp}`,
          type: 'agent-activation',
          aspects: {
            ephemeral: true
          },
          state: {
            targetAgent: botName,
            streamRef: {
              streamId,
              elementId: 'space',
              elementPath: []
            },
            streamId,
            conversationKey,
            triggeredBy: messageId,
            botPhone,
            reason: botMentioned ? 'mention' : quotedBot ? 'quote' : 'dm'
          },
          attributes: {
            streamId,
            conversationKey,
            triggeredBy: messageId,
            botPhone,
            reason: botMentioned ? 'mention' : quotedBot ? 'quote' : 'dm'
          }
        }
      });
    }

    console.log(`[SignalMessageReceptor] Returning ${deltas.length} deltas`);
    for (const delta of deltas) {
      if (delta.type === 'addFacet') {
        console.log(`  - ${delta.type}: ${delta.facet.type} (id: ${delta.facet.id})`);
      } else {
        console.log(`  - ${delta.type}`);
      }
    }

    return deltas;
  }
}

/**
 * SignalReceiptReceptor processes read receipts
 */
export class SignalReceiptReceptor extends BaseReceptor {
  topics = ['signal:receipt'];

  transform(event: SpaceEvent, state: ReadonlyVEILState): VEILDelta[] {
    const payload = event.payload as any;
    const { botPhone, source, isRead, isDelivery, timestamps } = payload;

    // Create ephemeral receipt facet
    // This could be used by transforms to update message state
    return [{
      type: 'addFacet',
      facet: {
        id: `signal-receipt-${source}-${Date.now()}`,
        type: 'receipt',
        aspects: {
          ephemeral: true
        },
        attributes: {
          botPhone,
          source,
          isRead,
          isDelivery,
          timestamps
        }
      }
    }];
  }
}

/**
 * SignalTypingReceptor processes typing indicators
 */
export class SignalTypingReceptor extends BaseReceptor {
  topics = ['signal:typing'];

  transform(event: SpaceEvent, state: ReadonlyVEILState): VEILDelta[] {
    const payload = event.payload as any;
    const { botPhone, source, groupId, action } = payload;

    const conversationKey = groupId || source;

    // Create ephemeral typing indicator facet
    return [{
      type: 'addFacet',
      facet: {
        id: `signal-typing-${conversationKey}-${source}`,
        type: 'typing-indicator',
        aspects: {
          ephemeral: true
        },
        attributes: {
          botPhone,
          source,
          conversationKey,
          action // 'STARTED' or 'STOPPED'
        }
      }
    }];
  }
}
