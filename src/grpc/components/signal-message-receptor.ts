/**
 * SignalMessageReceptor - gRPC equivalent of the non-gRPC SignalMessageReceptor
 *
 * Handles Signal message events and routes them appropriately:
 * - Emits messages to Connectome server as facets
 * - Routes mentions/replies to appropriate bots
 * - Handles bot-to-bot interaction limits
 * - Triggers agent activation for relevant messages
 *
 * This is the gRPC client-side equivalent - it doesn't extend Component
 * since it runs in the client, not the server's Space.
 */

import { messageDeduplicator } from '../../message-deduplicator.js';
import { replaceMentionPlaceholders, getNameToUuidCache } from '../utils/mention-resolver.js';
import type { BotInstance, SharedState, RuntimeConfig, SignalMessageEvent } from '../types.js';
import type { SignalAgentEffector } from './signal-agent-effector.js';
import type { SignalCommandEffector } from './signal-command-effector.js';

export interface SignalMessageReceptorConfig {
  bot: BotInstance;
  state: SharedState;
  agentEffector: SignalAgentEffector;
  commandEffector: SignalCommandEffector;
  updateConfig: (updates: Partial<RuntimeConfig>) => void;
}

/**
 * SignalMessageReceptor - Processes Signal messages into Connectome facets
 *
 * Constraint equivalent: RECEPTOR priority (runs early to transform events to facets)
 */
export class SignalMessageReceptor {
  private bot: BotInstance;
  private state: SharedState;
  private agentEffector: SignalAgentEffector;
  private commandEffector: SignalCommandEffector;
  private updateConfig: (updates: Partial<RuntimeConfig>) => void;

  // Per-bot deduplication for messages targeted at this bot
  // Prevents double-processing when WebSocket reconnects and re-receives messages
  private processedMessages = new Map<string, number>();
  private readonly PROCESSED_TTL = 30000; // 30 seconds
  private lastCleanup = Date.now();

  constructor(config: SignalMessageReceptorConfig) {
    this.bot = config.bot;
    this.state = config.state;
    this.agentEffector = config.agentEffector;
    this.commandEffector = config.commandEffector;
    this.updateConfig = config.updateConfig;
  }

  /**
   * Check if this bot has already processed this message
   */
  private hasProcessed(messageId: string): boolean {
    // Periodic cleanup
    const now = Date.now();
    if (now - this.lastCleanup > 10000) {
      this.lastCleanup = now;
      const cutoff = now - this.PROCESSED_TTL;
      for (const [id, timestamp] of this.processedMessages) {
        if (timestamp < cutoff) {
          this.processedMessages.delete(id);
        }
      }
    }

    return this.processedMessages.has(messageId);
  }

  /**
   * Mark a message as processed by this bot
   */
  private markProcessed(messageId: string): void {
    this.processedMessages.set(messageId, Date.now());
  }

  /**
   * Get this bot's UUID by reverse lookup from botUuidToName
   */
  private getBotUuid(): string | undefined {
    const botName = this.bot.config.name;
    for (const [uuid, name] of this.state.botUuidToName) {
      if (name === botName) {
        return uuid;
      }
    }
    return undefined;
  }

  /**
   * Handle incoming Signal message
   * Called by SignalWebSocketReceptor when a message is received
   *
   * Flow:
   * 1. Handle privacy mode (opt-in/opt-out) with `.` prefix
   * 2. Emit messages to Connectome based on privacy mode rules
   * 3. Check if should activate agent (bot mentioned/quoted)
   * 4. Check for self-mention (bot should not respond to itself)
   * 5. If yes, run agent
   */
  async handleMessage(event: SignalMessageEvent): Promise<void> {
    const botName = this.bot.config.name;
    const botPhone = this.bot.config.phone!;
    const botUuid = this.getBotUuid();

    // Build stream ID for tracking
    // For DMs: include bot phone to isolate each bot's conversation with a user
    // For groups: just use group ID (all bots share same group context)
    const streamId = event.groupId
      ? `signal:group:${event.groupId}`
      : `signal:dm:${botPhone}:${event.senderNumber || event.senderUuid}`;

    const isGroupMessage = !!event.groupId;
    const groupPrivacyMode = this.state.runtimeConfig.groupPrivacyMode;

    // Check if this bot was mentioned
    const botMentioned = this.isBotMentioned(event.mentions, botName);
    // Check if this bot was quoted
    const quotedBot = this.findQuotedBot(event.quotedMessage) === botName;

    // ============================================================
    // STEP 1: Handle privacy mode for group messages
    // ============================================================
    let processedContent = event.content || '';
    let shouldEmitToConnectome = true;

    if (isGroupMessage) {
      const hasDotPrefix = processedContent.startsWith('.');

      if (groupPrivacyMode === 'opt-in') {
        // Opt-in: Only store/process messages with "." prefix OR when bot is mentioned/quoted
        if (!hasDotPrefix && !botMentioned && !quotedBot) {
          // Message doesn't qualify for storage in opt-in mode
          shouldEmitToConnectome = false;
          console.log(`[SignalMessageReceptor:${botName}] Opt-in mode: Skipping message (no prefix, not mentioned)`);
        }
        // Remove "." prefix if present for processing
        if (hasDotPrefix) {
          processedContent = processedContent.substring(1).trim();
        }
      } else {
        // Opt-out (default): Store ALL messages UNLESS prefixed with "."
        if (hasDotPrefix) {
          // User explicitly opted out - don't store or respond
          console.log(`[SignalMessageReceptor:${botName}] Opt-out mode: Skipping message with '.' prefix`);
          return;
        }
      }
    }

    // Replace mention placeholders with @name for readable content
    const readableContent = replaceMentionPlaceholders(
      processedContent,
      event.mentions,
      this.state.botUuidToName
    );

    // Build message ID for deduplication
    const messageId = `${event.senderUuid || event.sender}-${event.timestamp}`;

    // Check if sender is a bot
    const isSenderBot = this.state.botUuidToName.has(event.senderUuid || '');

    // ============================================================
    // STEP 2: Emit messages to Connectome (based on privacy mode and deduplication)
    // ============================================================
    // For group messages, use deduplicator to ensure only one bot emits
    // For DMs, each bot handles their own stream so no deduplication needed

    if (isGroupMessage && shouldEmitToConnectome) {
      // Group message - use deduplication so only one bot emits
      const dedupeKey = `emit-${event.sender}-${event.timestamp}-${event.content?.substring(0, 50)}`;
      if (!messageDeduplicator.shouldEmit(dedupeKey, botPhone, isGroupMessage)) {
        shouldEmitToConnectome = false;
        console.log(`[SignalMessageReceptor:${botName}] Another bot will emit this message to Connectome`);
      }
    }

    if (shouldEmitToConnectome) {
      try {
        // Ensure stream exists on server
        await this.bot.streamManager.getOrCreateStream(
          event.groupId || event.senderNumber || event.senderUuid || 'unknown',
          {
            conversationType: event.groupId ? 'group' : 'dm',
            groupId: event.groupId,
            groupName: event.groupName,
            contactNumber: event.senderNumber,
            contactUuid: event.senderUuid,
            botPhone
          }
        );

        // Emit message to Connectome (creates facet in VEIL for context)
        await this.bot.grpcClient.emitSignalMessage({
          content: readableContent,
          sender: event.sender,
          senderNumber: event.senderNumber,
          senderUuid: event.senderUuid,
          groupId: event.groupId,
          groupName: event.groupName,
          botPhone,
          timestamp: event.timestamp,
          attachments: event.attachments,
          mentions: event.mentions,
          quotedMessage: event.quotedMessage
        });

        console.log(`[SignalMessageReceptor:${botName}] Emitted message to Connectome: ${readableContent.substring(0, 50)}...`);
      } catch (error: any) {
        console.error(`[SignalMessageReceptor:${botName}] Error emitting to Connectome:`, error.message);
      }
    }

    // ============================================================
    // STEP 3: Check for self-mention (bot should not respond to itself)
    // ============================================================
    const isSelfMention = botUuid && event.senderUuid === botUuid;
    if (isSelfMention) {
      console.log(`[SignalMessageReceptor:${botName}] Ignoring self-mention (sender is this bot)`);
      // Message was already emitted to Connectome for context, but don't activate agent
      return;
    }

    // ============================================================
    // STEP 4: Determine if agent should be activated
    // ============================================================
    // We already computed botMentioned and quotedBot earlier for privacy mode
    const mentionedBotName = this.findMentionedBot(event.mentions);
    const replyToBotName = this.findQuotedBot(event.quotedMessage);

    let shouldActivate = false;
    let activationReason = '';

    if (botMentioned) {
      // Check per-bot deduplication for targeted messages
      if (this.hasProcessed(messageId)) {
        console.log(`[SignalMessageReceptor:${botName}] Already processed message ${messageId.substring(0, 30)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'mention';
    } else if (mentionedBotName) {
      // Another bot was mentioned, this bot doesn't activate (but message was still emitted)
      // Do nothing
    } else if (quotedBot) {
      if (this.hasProcessed(messageId)) {
        console.log(`[SignalMessageReceptor:${botName}] Already processed message ${messageId.substring(0, 30)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'quote';
    } else if (replyToBotName) {
      // Another bot was quoted, this bot doesn't activate (but message was still emitted)
      // Do nothing
    } else if (!isGroupMessage) {
      // DM - this bot should respond
      if (this.hasProcessed(messageId)) {
        console.log(`[SignalMessageReceptor:${botName}] Already processed DM ${messageId.substring(0, 30)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'dm';
    } else {
      // Group message with no specific target - check random reply
      const randomChance = this.state.runtimeConfig.randomReplyChance;
      if (randomChance > 0 && !isSenderBot) {
        // Use deduplication for random reply decision
        const randomDedupeKey = `random-${event.sender}-${event.timestamp}`;
        if (messageDeduplicator.shouldEmit(randomDedupeKey, botPhone, isGroupMessage)) {
          const shouldRandomReply = Math.floor(Math.random() * randomChance) === 0;
          if (shouldRandomReply) {
            shouldActivate = true;
            activationReason = 'random';
            console.log(`[SignalMessageReceptor:${botName}] Random reply triggered (1/${randomChance})`);
          }
        }
      }
    }

    // If not activating, we're done (message was already emitted to Connectome)
    if (!shouldActivate) {
      return;
    }

    // Log activation
    console.log(`[SignalMessageReceptor:${botName}] Activating for message from ${event.sender}: ${readableContent.substring(0, 50)}... (${activationReason})`);

    // Handle ! commands
    const commandText = this.parseCommand(readableContent);
    if (commandText) {
      const response = this.commandEffector.handleCommand(
        commandText,
        this.state.runtimeConfig,
        this.updateConfig
      );
      if (response) {
        try {
          await this.sendSignalMessage(response, event);
          console.log(`[SignalMessageReceptor:${botName}] Handled command: ${commandText.substring(0, 30)}...`);
        } catch (error: any) {
          console.error(`[SignalMessageReceptor:${botName}] Error sending command response:`, error.message);
        }
        return; // Command handled, don't run agent
      }
    }

    // Mark this message as processed by this bot
    this.markProcessed(messageId);

    // ============================================================
    // STEP 5: Bot-to-bot limiting and agent activation
    // ============================================================
    if (isSenderBot) {
      const currentCount = this.state.botInteractionCounts.get(streamId) || 0;
      const maxBotMentions = this.state.runtimeConfig.maxBotMentionsPerConversation;

      if (maxBotMentions > 0 && currentCount >= maxBotMentions) {
        console.log(`[SignalMessageReceptor:${botName}] Bot-to-bot limit reached (${currentCount}/${maxBotMentions}), skipping agent`);
        return;
      }

      this.state.botInteractionCounts.set(streamId, currentCount + 1);
      console.log(`[SignalMessageReceptor:${botName}] Bot-to-bot interaction ${currentCount + 1}/${maxBotMentions}`);
    } else {
      // Human message - reset counter
      if (this.state.botInteractionCounts.has(streamId)) {
        this.state.botInteractionCounts.set(streamId, 0);
        console.log(`[SignalMessageReceptor:${botName}] Human message - reset bot-to-bot counter`);
      }
    }

    // Trigger agent activation
    try {
      if (this.bot.agent) {
        await this.agentEffector.runAgentCycle({
          streamId,
          event,
          readableContent,
          activationReason
        });
      } else {
        console.log(`[SignalMessageReceptor:${botName}] No agent configured, skipping response`);
      }
    } catch (error: any) {
      console.error(`[SignalMessageReceptor:${botName}] Error running agent:`, error.message);
    }
  }

  /**
   * Parse command from message text
   * Strips leading @mention if present, returns the command text or null if not a command
   *
   * Examples:
   * - "@botname !help" -> "!help"
   * - "!rr 5" -> "!rr 5"
   * - "hello" -> null
   */
  private parseCommand(message: string): string | null {
    if (!message) return null;

    let cleaned = message.trim();

    // Strip leading @mention if present (format: "@botname rest of message")
    // This handles the case where user sends "@botname !help"
    if (cleaned.startsWith('@')) {
      const spaceIndex = cleaned.indexOf(' ');
      if (spaceIndex > 0) {
        cleaned = cleaned.substring(spaceIndex + 1).trim();
      } else {
        // Just a mention with no content
        return null;
      }
    }

    // Check if it's a command
    if (!cleaned.startsWith('!')) return null;

    return cleaned;
  }

  /**
   * Find if any of our bots was mentioned
   */
  private findMentionedBot(mentions: SignalMessageEvent['mentions']): string | undefined {
    if (!mentions) return undefined;

    for (const mention of mentions) {
      const botName = this.state.botUuidToName.get(mention.uuid);
      if (botName) {
        return botName;
      }
    }

    return undefined;
  }

  /**
   * Check if THIS specific bot was mentioned
   */
  private isBotMentioned(mentions: SignalMessageEvent['mentions'], targetBotName: string): boolean {
    if (!mentions) return false;

    for (const mention of mentions) {
      const botName = this.state.botUuidToName.get(mention.uuid);
      if (botName === targetBotName) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find if quoted message was from one of our bots
   */
  private findQuotedBot(quote: SignalMessageEvent['quotedMessage']): string | undefined {
    if (!quote?.authorUuid) return undefined;

    return this.state.botUuidToName.get(quote.authorUuid);
  }

  /**
   * Send a message to Signal (for command responses)
   */
  private async sendSignalMessage(content: string, originalEvent: SignalMessageEvent): Promise<void> {
    const { getSignalCliConfig } = await import('../config-loader.js');
    const { convertGroupId } = await import('../utils/group-id-converter.js');
    const { default: axios } = await import('axios');
    const { apiUrl } = getSignalCliConfig();

    const body: any = {
      number: this.bot.config.phone,
      message: content
    };

    if (originalEvent.groupId) {
      // Convert internal group ID to external group ID for Signal CLI API
      const externalGroupId = await convertGroupId(originalEvent.groupId, this.bot.config.phone!);
      body.recipients = [externalGroupId || originalEvent.groupId];
    } else {
      body.recipients = [originalEvent.senderNumber || originalEvent.senderUuid];
    }

    await axios.post(`${apiUrl}/v2/send`, body, {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
