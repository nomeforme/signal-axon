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
   * Handle incoming Signal message
   * Called by SignalWebSocketReceptor when a message is received
   */
  async handleMessage(event: SignalMessageEvent): Promise<void> {
    const botName = this.bot.config.name;
    const botPhone = this.bot.config.phone!;

    // Build stream ID for tracking
    // For DMs: include bot phone to isolate each bot's conversation with a user
    // For groups: just use group ID (all bots share same group context)
    const streamId = event.groupId
      ? `signal:group:${event.groupId}`
      : `signal:dm:${botPhone}:${event.senderNumber || event.senderUuid}`;

    const isGroupMessage = !!event.groupId;

    // Replace mention placeholders with @name for readable content
    const readableContent = replaceMentionPlaceholders(
      event.content,
      event.mentions,
      this.state.botUuidToName
    );

    // Check routing FIRST (before deduplication)
    // This ensures that messages with specific targets (mentions/replies)
    // are handled by the correct bot, not just whichever bot wins the race
    const mentionedBotName = this.findMentionedBot(event.mentions);
    const replyToBotName = this.findQuotedBot(event.quotedMessage);

    // Routing logic: determine if this bot should handle the message
    let shouldActivate = false;
    let activationReason = '';
    let hasSpecificTarget = false; // True if message is meant for a specific bot

    // Build message ID for per-bot deduplication
    const messageId = `${event.senderUuid || event.sender}-${event.timestamp}`;

    if (mentionedBotName) {
      hasSpecificTarget = true;
      if (mentionedBotName === botName) {
        // Check per-bot deduplication for targeted messages
        // This prevents double-processing when WebSocket reconnects
        if (this.hasProcessed(messageId)) {
          console.log(`[SignalMessageReceptor:${botName}] Already processed message ${messageId.substring(0, 30)}...`);
          return;
        }
        shouldActivate = true;
        activationReason = 'mention';
      } else {
        // Message is for a different bot - skip without logging (reduces noise)
        return;
      }
    } else if (replyToBotName) {
      hasSpecificTarget = true;
      if (replyToBotName === botName) {
        // Check per-bot deduplication for targeted messages
        if (this.hasProcessed(messageId)) {
          console.log(`[SignalMessageReceptor:${botName}] Already processed message ${messageId.substring(0, 30)}...`);
          return;
        }
        shouldActivate = true;
        activationReason = 'quote';
      } else {
        // Reply is for a different bot - skip without logging (reduces noise)
        return;
      }
    } else if (!isGroupMessage) {
      // DM - check per-bot dedup (in case of WebSocket reconnect)
      if (this.hasProcessed(messageId)) {
        console.log(`[SignalMessageReceptor:${botName}] Already processed DM ${messageId.substring(0, 30)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'dm';
    } else {
      // Group message with no specific target - use deduplication
      // Only ONE bot should process (for random reply or just to emit the message)
      const dedupeKey = `${event.sender}-${event.timestamp}-${event.content?.substring(0, 50)}`;
      if (!messageDeduplicator.shouldEmit(dedupeKey, botPhone, isGroupMessage)) {
        console.log(`[SignalMessageReceptor:${botName}] Skipping duplicate message`);
        return;
      }

      // Check random reply
      const randomChance = this.state.runtimeConfig.randomReplyChance;
      if (randomChance > 0) {
        const shouldRandomReply = Math.floor(Math.random() * randomChance) === 0;
        if (shouldRandomReply) {
          shouldActivate = true;
          activationReason = 'random';
          console.log(`[SignalMessageReceptor:${botName}] Random reply triggered (1/${randomChance})`);
        }
      }
    }

    // Log activation reason if we're going to process
    if (shouldActivate) {
      console.log(`[SignalMessageReceptor:${botName}] Message from ${event.sender}: ${readableContent.substring(0, 50)}... (${activationReason})`);
    }

    // Handle ! commands (only if we're the one processing this message)
    // Parse command from message - strip @mention prefix if present
    const commandText = this.parseCommand(readableContent);
    if (shouldActivate && commandText) {
      const response = this.commandEffector.handleCommand(
        commandText,
        this.state.runtimeConfig,
        this.updateConfig
      );
      if (response) {
        // Send command response directly
        try {
          await this.sendSignalMessage(response, event);
          console.log(`[SignalMessageReceptor:${botName}] Handled command: ${commandText.substring(0, 30)}...`);
        } catch (error: any) {
          console.error(`[SignalMessageReceptor:${botName}] Error sending command response:`, error.message);
        }
        return; // Command handled, don't process further
      }
    }

    if (!shouldActivate) {
      return;
    }

    // Mark this message as processed by this bot
    // This prevents duplicate processing on WebSocket reconnection
    this.markProcessed(messageId);

    // Bot-to-bot limiting (check if sender is a bot)
    const isSenderBot = this.state.botUuidToName.has(event.senderUuid || '');
    if (isSenderBot) {
      const currentCount = this.state.botInteractionCounts.get(streamId) || 0;
      const maxBotMentions = this.state.runtimeConfig.maxBotMentionsPerConversation;

      if (maxBotMentions > 0 && currentCount >= maxBotMentions) {
        console.log(`[SignalMessageReceptor:${botName}] Bot-to-bot limit reached (${currentCount}/${maxBotMentions}), skipping`);
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

      // Emit message to Connectome (for state tracking)
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

      // Trigger agent activation
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
      console.error(`[SignalMessageReceptor:${botName}] Error handling message:`, error.message);
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
