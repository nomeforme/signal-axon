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
  // Maximum conversation frames to include in context (rolling window)
  maxConversationFrames?: number;
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

  /**
   * Update config at runtime (called by command effector)
   */
  updateConfig(updates: Partial<SignalReceptorConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log('[SignalMessageReceptor] Config updated:', updates);
  }

  /**
   * Get current config values (for displaying current settings)
   */
  getConfig(): SignalReceptorConfig {
    return this.config;
  }

  /**
   * Parse command from message text
   * Returns { command, args } or null if not a command
   * Handles messages that start with mention placeholder (FFFC) before the command
   */
  private parseCommand(message: string): { command: string; args: string } | null {
    if (!message) return null;

    // Strip leading FFFC (mention placeholder) and whitespace
    // Message format is typically: "￼ !command args" where ￼ is FFFC
    let cleaned = message.replace(/^\uFFFC\s*/g, '').trim();

    if (!cleaned.startsWith('!')) return null;

    const parts = cleaned.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();

    return { command, args };
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
      timestamp,
      __reprocessed // Flag from consistency checker for re-processed messages
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

    // For group chats with deduplication, we need to check ALL bots for mentions/quotes
    // The botPhone in the payload is just "first receiver" - not who should respond
    // For DMs, only the receiving bot matters

    // Helper to check if a specific bot was mentioned
    const isBotMentioned = (phone: string): boolean => {
      const uuid = this.config.botUuids.get(phone);
      return mentions?.some((m: any) => {
        const uuidMatch = uuid && m.uuid === uuid;
        const numberMatch = m.number === phone;
        return uuidMatch || numberMatch;
      }) || false;
    };

    // Helper to check if a specific bot was quoted
    const isBotQuoted = (phone: string): boolean => {
      if (!quote) return false;
      const uuid = this.config.botUuids.get(phone);
      return (uuid && quote.authorUuid === uuid) || quote.author === phone;
    };

    // For backward compatibility and DMs, check the payload's botPhone
    const botUuid = this.config.botUuids.get(botPhone);
    const botMentioned = isBotMentioned(botPhone);
    const quotedBot = isBotQuoted(botPhone);

    console.log(`[SignalMessageReceptor] botPhone: ${botPhone}, botUuid: ${botUuid}, mentioned: ${botMentioned}, quoted: ${quotedBot}`);
    if (quote) {
      console.log(`[SignalMessageReceptor] Quote: authorUuid=${quote.authorUuid}, author=${quote.author}`);
    }

    // Find the first mentioned bot (for command handling)
    const mentionedBotPhone = Array.from(this.config.botNames.keys()).find(phone => isBotMentioned(phone));

    // Parse commands - only process if a bot was mentioned and message starts with !
    // IMPORTANT: Only the mentioned bot should create the command facet
    // With multiple bots in separate processes, each one receives the message
    // We must ensure only ONE bot (the mentioned one) handles the command
    // BUT all bots must return early to prevent agent-activations for command messages
    const parsed = this.parseCommand(message);
    if (parsed && mentionedBotPhone && !isBotMessage) {
      const { command, args } = parsed;

      // Handle recognized commands
      if (command === '!rr' || command === '!bb' || command === '!mf' || command === '!help') {
        // With shared VEIL state and deduplication, only one bot emits the event
        // Create the command facet for the mentioned bot regardless of which bot emitted
        console.log(`[SignalMessageReceptor] Command detected: ${command} ${args} (mentioned bot: ${mentionedBotPhone})`);

        // Create command facet for effector to handle
        deltas.push({
          type: 'addFacet',
          facet: {
            id: `signal-command-${timestamp}`,
            type: 'signal-command',
            streamId,
            aspects: { ephemeral: true },
            state: {
              command,
              args,
              botPhone: mentionedBotPhone,
              source,
              groupId,
              timestamp,
              currentConfig: {
                randomReplyChance: this.config.randomReplyChance || 0,
                maxBotMentionsPerConversation: this.config.maxBotMentionsPerConversation ?? 10,
                maxConversationFrames: this.config.maxConversationFrames!,
                currentFrameCount: state.frameHistory.length
              }
            }
          }
        });

        // ALL bots return early for command messages - no agent activations
        // Don't store command messages in history
        return deltas;
      }
    }

    // Determine if bot should respond and if message should be stored in context
    let shouldRespond = false;
    let storeInHistory = true;

    // Replace U+FFFC (Object Replacement Character) with actual mention names
    // Signal uses FFFC as placeholder at specific positions, we need to restore @name for context
    let processedMessage = message;
    if (mentions && mentions.length > 0) {
      // Sort mentions by position descending so we can replace from end to start
      // (this prevents position shifts from affecting subsequent replacements)
      const sortedMentions = [...mentions].sort((a: any, b: any) => (b.start ?? 0) - (a.start ?? 0));

      for (const mention of sortedMentions) {
        // Find the display name for this mention
        let mentionName: string | undefined;

        // First try to find bot name by UUID
        if (mention.uuid) {
          for (const [phone, uuid] of this.config.botUuids.entries()) {
            if (uuid === mention.uuid) {
              mentionName = this.config.botNames.get(phone);
              break;
            }
          }
        }

        // If not a bot, try to find by phone number
        if (!mentionName && mention.number) {
          mentionName = this.config.botNames.get(mention.number);
        }

        // For non-bot users, we need a display name
        // The mention.name field often contains phone/UUID, so look up profile
        if (!mentionName) {
          // Try to get display name from profile facets
          const profileFacetId = `signal-profile-${mention.uuid || mention.number}`;
          const profileFacet = state.facets.get(profileFacetId);
          if (profileFacet) {
            mentionName = profileFacet.attributes?.displayName || profileFacet.content;
          }
        }

        // Fall back to mention.name only if it looks like a display name (not UUID/phone)
        if (!mentionName && mention.name) {
          const isUuid = /^[0-9a-f-]{36}$/i.test(mention.name);
          const isPhone = /^\+?\d+$/.test(mention.name);
          if (!isUuid && !isPhone) {
            mentionName = mention.name;
          }
        }

        // Use position-based replacement for accuracy
        const start = mention.start ?? 0;
        const length = mention.length ?? 1;
        const replacement = `@${mentionName || 'user'}`;

        // Only replace if we have valid position and the character at that position is FFFC
        if (start >= 0 && start < processedMessage.length) {
          const before = processedMessage.slice(0, start);
          const after = processedMessage.slice(start + length);
          processedMessage = before + replacement + after;
        }
      }
    }
    // Strip any remaining FFFC characters (edge cases)
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
        const maxBotMentions = this.config.maxBotMentionsPerConversation ?? 10;

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
      // randomReplyChance represents "1 in N" chance:
      // - 1 = 100% chance (1 in 1)
      // - 10 = 10% chance (1 in 10)
      // - 100 = 1% chance (1 in 100)
      // - 200 = 0.5% chance (1 in 200)
      if (!shouldRespond && randomReplyChance > 0 && storeInHistory) {
        const roll = Math.floor(Math.random() * randomReplyChance) + 1;
        shouldRespond = roll === 1; // 1 in N chance
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

    // Create agent activations
    // For DMs: activate the receiving bot
    // For group chats: activate ALL mentioned/quoted bots (with deduplication, one event serves all)
    if (!isGroupChat) {
      // DM - activate the receiving bot
      if (shouldRespond) {
        const activationId = `signal-activation-${botPhone}-${timestamp}`;

        // Skip if activation already exists (prevents duplicates from consistency checker re-processing)
        if (state.facets.get(activationId)) {
          console.log(`[SignalMessageReceptor] Skipping duplicate activation: ${activationId}`);
        } else {
          const botName = this.config.botNames.get(botPhone);
          console.log(`[SignalMessageReceptor] Creating agent-activation for DM: botPhone ${botPhone}, targetAgent: ${botName}`);

          deltas.push({
            type: 'addFacet',
            facet: {
              id: activationId,
              type: 'agent-activation',
              aspects: { ephemeral: true },
              state: {
                targetAgent: botName,
                streamRef: { streamId, elementId: 'space', elementPath: [] },
                streamId,
                conversationKey,
                triggeredBy: messageId,
                botPhone,
                reason: 'dm'
              },
              attributes: { streamId, conversationKey, triggeredBy: messageId, botPhone, reason: 'dm' }
            }
          });
        }
      }
    } else {
      // Group chat - check ALL bots for mentions/quotes and create activations
      // With deduplication, only one signal:message event is emitted per group message
      for (const [targetBotPhone, targetBotName] of this.config.botNames.entries()) {
        const targetBotUuid = this.config.botUuids.get(targetBotPhone);

        // Skip if this bot sent the message (don't respond to self)
        if (sourceUuid === targetBotUuid) continue;

        const targetMentioned = isBotMentioned(targetBotPhone);
        const targetQuoted = isBotQuoted(targetBotPhone);
        let targetShouldRespond = targetMentioned || targetQuoted;

        // Bot-to-bot loop prevention
        // Skip entirely for re-processed messages to avoid stale counter checks
        if (targetShouldRespond && isBotMessage) {
          if (__reprocessed) {
            console.log(`[BOT LOOP PREVENTION] Skipping bot-to-bot check for re-processed message`);
            targetShouldRespond = false;
          } else {
            const maxBotMentions = this.config.maxBotMentionsPerConversation ?? 10;
            const counterFacetId = `bot-interaction-counter-${targetBotPhone}-${streamId}`;
            const counterFacet = state.facets.get(counterFacetId);
            const currentCount = (counterFacet?.state as any)?.count || 0;

            if (currentCount >= maxBotMentions) {
              console.log(`[BOT LOOP PREVENTION] ⚠ Bot ${targetBotPhone} at limit (${currentCount}/${maxBotMentions}), skipping`);
              targetShouldRespond = false;
            } else {
              console.log(`[BOT LOOP PREVENTION] Bot ${targetBotPhone} mentioned by bot (${currentCount}/${maxBotMentions})`);
            }
          }
        }

        // Random reply for non-mentioned bots (human messages only)
        if (!targetShouldRespond && !isBotMessage && storeInHistory) {
          const randomReplyChance = this.config.randomReplyChance || 0;
          if (randomReplyChance > 0) {
            const roll = Math.floor(Math.random() * randomReplyChance) + 1;
            targetShouldRespond = roll === 1; // 1 in N chance
            if (targetShouldRespond) {
              console.log(`[SignalMessageReceptor] Random reply triggered for ${targetBotPhone}`);
            }
          }
        }

        if (targetShouldRespond) {
          const activationId = `signal-activation-${targetBotPhone}-${timestamp}`;

          // Skip if activation already exists (prevents duplicates from consistency checker re-processing)
          if (state.facets.get(activationId)) {
            console.log(`[SignalMessageReceptor] Skipping duplicate activation: ${activationId}`);
            continue;
          }

          const reason = targetMentioned ? 'mention' : targetQuoted ? 'quote' : 'random';
          console.log(`[SignalMessageReceptor] Creating agent-activation for group: botPhone ${targetBotPhone}, targetAgent: ${targetBotName}, reason: ${reason}`);

          deltas.push({
            type: 'addFacet',
            facet: {
              id: activationId,
              type: 'agent-activation',
              aspects: { ephemeral: true },
              state: {
                targetAgent: targetBotName,
                streamRef: { streamId, elementId: 'space', elementPath: [] },
                streamId,
                conversationKey,
                triggeredBy: messageId,
                botPhone: targetBotPhone,
                reason
              },
              attributes: { streamId, conversationKey, triggeredBy: messageId, botPhone: targetBotPhone, reason }
            }
          });

          // Update bot interaction counter for bot-to-bot mentions
          if (isBotMessage) {
            const counterFacetId = `bot-interaction-counter-${targetBotPhone}-${streamId}`;
            const counterFacet = state.facets.get(counterFacetId);
            const currentCount = (counterFacet?.state as any)?.count || 0;

            if (counterFacet) {
              deltas.push({ type: 'removeFacet', id: counterFacetId });
            }
            deltas.push({
              type: 'addFacet',
              facet: {
                id: counterFacetId,
                type: 'bot-interaction-counter',
                streamId,
                botPhone: targetBotPhone,
                aspects: { ephemeral: true },
                state: { count: currentCount + 1 }
              }
            });
          }
        }
      }

      // Reset bot counters for human messages
      if (!isBotMessage) {
        for (const [targetBotPhone] of this.config.botNames.entries()) {
          const counterFacetId = `bot-interaction-counter-${targetBotPhone}-${streamId}`;
          const counterFacet = state.facets.get(counterFacetId);
          const currentCount = (counterFacet?.state as any)?.count || 0;

          if (counterFacet && currentCount > 0) {
            console.log(`[BOT LOOP PREVENTION] Human message. Resetting counter for ${targetBotPhone}.`);
            deltas.push({ type: 'removeFacet', id: counterFacetId });
          }
        }
      }
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
