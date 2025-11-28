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
      sourceName, // Signal display name from envelope
      groupId,
      message,
      attachments,
      mentions,
      quote,
      timestamp
    } = payload;

    console.log(`[SignalMessageReceptor] Processing message from ${source}: "${message}" (botPhone: ${botPhone})`);
    console.log(`[SignalMessageReceptor] mentions value:`, mentions, `type:`, typeof mentions, `length:`, mentions?.length);
    if (mentions && mentions.length > 0) {
      console.log(`[SignalMessageReceptor] Mentions:`, JSON.stringify(mentions));
    }
    if (quote) {
      console.log(`[SignalMessageReceptor] Quote detected:`, JSON.stringify(quote));
    }

    const deltas: VEILDelta[] = [];

    // Check if this message is from a bot
    const isBotMessage = this.config.botUuids.has(source) ||
                         (sourceUuid && Array.from(this.config.botUuids.values()).includes(sourceUuid));

    // Note: We no longer skip bot messages entirely here.
    // Bot messages don't need to be stored (handled by agent facets),
    // but we still need to check if THIS bot was mentioned by another bot.

    // Determine conversation key
    const conversationKey = groupId || source;
    const isGroupChat = !!groupId;
    // For DMs, include botPhone in streamId so each bot has its own stream with the user
    // For groups, just use the groupId since all bots share the same group conversation
    const streamId = isGroupChat
      ? `signal-stream-${conversationKey}`
      : `signal-stream-${botPhone}-${conversationKey}`;

    // Check if message already exists (deduplication)
    // Note: We still need to check if THIS bot should respond, even if message facet exists
    const messageId = `signal-msg-${source}-${timestamp}`;
    const existingMessage = state.facets.get(messageId);
    const messageAlreadyExists = !!existingMessage;

    // Look up cached display name from VEIL state
    const profileFacet = Array.from(state.facets.values())
      .find(f => f.type === 'user-profile' &&
                 (f.attributes?.phoneNumber === source || f.attributes?.uuid === sourceUuid));

    // Extract display name - prefer sourceName from envelope, then cached profile, then source
    let displayName = sourceName || source;

    // If no sourceName from envelope, use cached profile
    if (!sourceName) {
      if (profileFacet?.attributes?.displayName) {
        displayName = profileFacet.attributes.displayName;
      } else if (profileFacet?.content) {
        displayName = profileFacet.content;
      }
    }

    // Check if bot was mentioned (check both UUID and phone number)
    const botUuid = this.config.botUuids.get(botPhone);
    console.log(`[SignalMessageReceptor] botPhone: ${botPhone}, botUuid: ${botUuid}`);
    const botMentioned = mentions?.some((m: any) => {
      const uuidMatch = botUuid && m.uuid === botUuid;
      const numberMatch = m.number === botPhone;
      console.log(`[SignalMessageReceptor]   Checking mention: uuid=${m.uuid} (match: ${uuidMatch}), number=${m.number} (match: ${numberMatch})`);
      return uuidMatch || numberMatch;
    }) || false;
    console.log(`[SignalMessageReceptor] botMentioned: ${botMentioned}`);
    // Check if message quotes/replies to the bot (need to check both UUID and phone number)
    const quotedBot = quote && (
      (botUuid && quote.authorUuid === botUuid) ||
      quote.author === botPhone
    );
    if (quote) {
      console.log(`[SignalMessageReceptor] Quote check: authorUuid=${quote.authorUuid}, author=${quote.author}, botUuid=${botUuid}, botPhone=${botPhone}, quotedBot=${quotedBot}`);
    }

    // Determine if bot should respond and if message should be stored in context
    let shouldRespond = false;
    let storeInHistory = true;

    // Replace U+FFFC (Object Replacement Character) with actual mention names
    // Signal uses FFFC as placeholder, we need to restore the @name for context
    let processedMessage = message;
    if (mentions && mentions.length > 0) {
      // Sort mentions by position descending so we can replace from end to start
      // (this prevents position shifts from affecting subsequent replacements)
      const sortedMentions = [...mentions].sort((a: any, b: any) => (b.start || 0) - (a.start || 0));
      for (const mention of sortedMentions) {
        // Find the mention name - always look up from bot config first
        let mentionName: string | undefined;

        // First try to find bot name by UUID
        for (const [phone, uuid] of this.config.botUuids.entries()) {
          if (uuid === mention.uuid) {
            mentionName = this.config.botNames.get(phone);
            break;
          }
        }

        // If not a bot, try to find by phone number
        if (!mentionName && mention.number) {
          mentionName = this.config.botNames.get(mention.number);
        }

        // Fall back to mention.name only if it's not a UUID or phone number pattern
        if (!mentionName && mention.name) {
          const isUuid = /^[0-9a-f-]{36}$/i.test(mention.name);
          const isPhone = /^\+?\d+$/.test(mention.name);
          if (!isUuid && !isPhone) {
            mentionName = mention.name;
          }
        }

        // Replace FFFC with @name
        processedMessage = processedMessage.replace('\uFFFC', `@${mentionName || mention.name || mention.uuid || 'unknown'}`);
      }
    }
    // Strip any remaining FFFC characters (shouldn't happen but just in case)
    processedMessage = processedMessage.replace(/\uFFFC/g, '').trim();

    // Bot messages are NOT stored in history (they're handled by agent facets)
    // But we still check for mentions to trigger responses
    if (isBotMessage) {
      storeInHistory = false;
      // Check if this bot was mentioned by another bot (but NOT by itself!)
      const isSelfMention = sourceUuid === botUuid;
      if (isSelfMention) {
        console.log(`[SignalMessageReceptor] Ignoring self-mention from ${source} to ${botPhone}`);
        shouldRespond = false;
      } else if (botMentioned) {
        // Bot-to-bot mention - check loop prevention limit
        const maxBotMentions = this.config.maxBotMentionsPerConversation || 10;

        // Count consecutive bot-to-bot interactions since last human message
        // Counter is PER-BOT per stream to avoid race conditions
        const counterFacetId = `bot-interaction-counter-${botPhone}-${streamId}`;
        const counterFacet = state.facets.get(counterFacetId);
        const currentCount = (counterFacet?.state as any)?.count || 0;

        // Check BEFORE incrementing - allow if count is less than limit
        if (currentCount < maxBotMentions) {
          shouldRespond = true;
          console.log(`[BOT LOOP PREVENTION] Bot ${botPhone} mentioned by bot. Will respond (${currentCount}/${maxBotMentions} interactions so far)`);
        } else {
          console.log(`[BOT LOOP PREVENTION] ⚠ Limit reached (${currentCount}/${maxBotMentions})! Skipping to prevent infinite loop.`);
          shouldRespond = false;
        }
      } else {
        shouldRespond = false;
        console.log(`[SignalMessageReceptor] Bot message from ${source}, not mentioned`);
      }
    } else if (!isGroupChat) {
      // Always respond in DMs
      shouldRespond = true;
      storeInHistory = true;
    } else {
      // Group chat logic - privacy mode controls what gets stored in history
      const groupPrivacyMode = this.config.groupPrivacyMode || 'opt-in';
      const randomReplyChance = this.config.randomReplyChance || 0;

      // In ALL modes, bots only respond when mentioned or quoted
      // (random replies can override this below)
      shouldRespond = botMentioned || quotedBot;

      // Privacy mode controls what gets stored in conversation history:
      if (groupPrivacyMode === 'opt-in') {
        // Opt-in: Only store messages with "." prefix OR when bot is mentioned
        const hasDotPrefix = message.startsWith('.');
        storeInHistory = hasDotPrefix || botMentioned || quotedBot;

        // Remove "." prefix if present
        if (hasDotPrefix) {
          processedMessage = message.substring(1).trim();
        }
      } else {
        // Opt-out: Store ALL messages UNLESS prefixed with "."
        if (message.startsWith('.')) {
          // User explicitly opted out of this message - don't store or respond
          return [];
        }
        storeInHistory = true;
      }

      // Random reply feature: Give bot a chance to respond even when not mentioned
      // randomReplyChance is 1-100 where:
      // - 1 = 100% chance (always reply)
      // - 100 = 1% chance (1/100)
      // - 10 = 10% chance (1/10)
      if (!shouldRespond && randomReplyChance > 0 && storeInHistory) {
        const roll = Math.floor(Math.random() * 100) + 1;
        shouldRespond = roll <= (100 / randomReplyChance);
      }

      // Check max bot mentions per conversation
      // After threshold is reached, require explicit mention or quote
      if (shouldRespond && this.config.maxBotMentionsPerConversation) {
        const botResponseCount = Array.from(state.facets.values())
          .filter(f => f.type === 'speech' &&
                       f.agentId &&
                       f.streamId === streamId)
          .length;

        if (botResponseCount >= this.config.maxBotMentionsPerConversation) {
          // Require explicit mention or quote after threshold
          if (!botMentioned && !quotedBot) {
            shouldRespond = false;
          }
        }
      }
    }

    // Bot loop prevention counter management (per-bot to avoid race conditions)
    if (isGroupChat) {
      const counterFacetId = `bot-interaction-counter-${botPhone}-${streamId}`;
      const counterFacet = state.facets.get(counterFacetId);
      const currentCount = (counterFacet?.state as any)?.count || 0;

      if (isBotMessage && shouldRespond) {
        // Increment counter for bot-to-bot interaction
        // Remove old counter first if it exists
        if (counterFacet) {
          deltas.push({ type: 'removeFacet', id: counterFacetId });
        }
        deltas.push({
          type: 'addFacet',
          facet: {
            id: counterFacetId,
            type: 'bot-interaction-counter',
            streamId,
            botPhone,
            aspects: { ephemeral: true },
            state: { count: currentCount + 1 }
          }
        });
        console.log(`[BOT LOOP PREVENTION] Incremented counter for ${botPhone} to ${currentCount + 1}`);
      } else if (!isBotMessage) {
        // Human message - reset counter for THIS bot
        if (counterFacet && currentCount > 0) {
          console.log(`[BOT LOOP PREVENTION] Human message detected. Resetting bot counter for ${botPhone}.`);
          deltas.push({ type: 'removeFacet', id: counterFacetId });
          deltas.push({
            type: 'addFacet',
            facet: {
              id: counterFacetId,
              type: 'bot-interaction-counter',
              streamId,
              botPhone,
              aspects: { ephemeral: true },
              state: { count: 0 }
            }
          });
        }
      }
    }

    // Only create message facets if message doesn't already exist (deduplication)
    // But we still need to create agent-activation if THIS bot was mentioned
    if (!messageAlreadyExists && storeInHistory) {
      // Create speech facet as nested child (matching Discord pattern)
      const speechFacet: any = {
        id: `speech-${messageId}`,
        type: 'speech',
        content: processedMessage,
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
              timestamp,
              attachments: attachments?.map((a: any) => ({
                contentType: a.contentType,
                filename: a.filename,
                id: a.id,
                size: a.size,
                data: a.data  // base64 encoded image data (if downloaded)
              }))
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
              id: a.id,
              size: a.size,
              data: a.data  // base64 encoded image data (if downloaded)
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
    }

    // Create agent activation if bot should respond
    if (shouldRespond || !isGroupChat) {
      // Get target agent name for this bot (matches the agent's config.name)
      const botName = this.config.botNames.get(botPhone);

      console.log(`[SignalMessageReceptor] Creating agent-activation for botPhone ${botPhone}, targetAgent: ${botName}, streamId: ${streamId}, reason: ${botMentioned ? 'mention' : quotedBot ? 'quote' : 'dm'}`);

      deltas.push({
        type: 'addFacet',
        facet: {
          id: `signal-activation-${botPhone}-${timestamp}`,
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
