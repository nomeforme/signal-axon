/**
 * MessageConsistencyChecker - Ensures mentioned/quoted bots receive messages
 *
 * In multi-bot Signal setups, sometimes a WebSocket connection might miss a message
 * that other bots received. This component:
 * 1. Tracks which bots receive each group message
 * 2. After a delay, checks if targeted bots (mentioned/quoted) missed the message
 * 3. If so, triggers reconnection and re-injects the message for processing
 *
 * This is the gRPC equivalent of MessageConsistencyReceptor from signal-axon-host.
 */

import type { SignalMessageEvent, SignalMention } from '../types.js';
import type { SignalWebSocketReceptor } from './signal-websocket-receptor.js';

export interface MessageConsistencyConfig {
  // Map of bot UUID to bot name
  botUuidToName: Map<string, string>;
  // Map of bot phone to bot name
  botPhoneToName: Map<string, string>;
  // All bot phone numbers
  allBotPhones: string[];
  // WebSocket handlers for reconnection
  wsHandlers: Map<string, SignalWebSocketReceptor>;
  // Message handlers to re-process messages
  messageHandlers: Map<string, (event: SignalMessageEvent) => Promise<void>>;
  // Delay before checking consistency (ms)
  checkDelayMs?: number;
}

interface MessageTracker {
  messageId: string;
  timestamp: number;
  receivedBy: Set<string>;  // Bot phones that received this message
  mentions: SignalMention[];
  quotedBotUuid?: string;
  messagePayload: SignalMessageEvent;
  timeout: NodeJS.Timeout;
  groupId: string;
}

export class MessageConsistencyChecker {
  private config: MessageConsistencyConfig;
  private messageTrackers = new Map<string, MessageTracker>();
  private readonly checkDelayMs: number;

  constructor(config: MessageConsistencyConfig) {
    this.config = config;
    this.checkDelayMs = config.checkDelayMs ?? 2000;  // Default 2 seconds
  }

  /**
   * Record that a bot received a message
   * Call this from each bot's message handler BEFORE any filtering/deduplication
   */
  recordMessage(event: SignalMessageEvent, botPhone: string): void {
    // Only track group messages
    if (!event.groupId) {
      return;
    }

    const messageId = `${event.senderUuid || event.sender}-${event.timestamp}`;

    let tracker = this.messageTrackers.get(messageId);

    if (!tracker) {
      tracker = {
        messageId,
        timestamp: event.timestamp,
        receivedBy: new Set(),
        mentions: event.mentions || [],
        quotedBotUuid: event.quotedMessage?.authorUuid,
        messagePayload: event,
        groupId: event.groupId!,
        timeout: setTimeout(() => this.checkConsistency(messageId), this.checkDelayMs)
      };
      this.messageTrackers.set(messageId, tracker);
    }

    tracker.receivedBy.add(botPhone);
  }

  /**
   * Check if all targeted bots received the message
   */
  private checkConsistency(messageId: string): void {
    const tracker = this.messageTrackers.get(messageId);
    if (!tracker) return;

    // Find which bots were targeted (mentioned or quoted)
    const targetedBotPhones = new Set<string>();

    // Check mentions
    for (const mention of tracker.mentions) {
      const botName = this.config.botUuidToName.get(mention.uuid);
      if (botName) {
        // Find phone for this bot name
        for (const [phone, name] of this.config.botPhoneToName) {
          if (name === botName) {
            targetedBotPhones.add(phone);
            break;
          }
        }
      }
    }

    // Check quote
    if (tracker.quotedBotUuid) {
      const quotedBotName = this.config.botUuidToName.get(tracker.quotedBotUuid);
      if (quotedBotName) {
        for (const [phone, name] of this.config.botPhoneToName) {
          if (name === quotedBotName) {
            targetedBotPhones.add(phone);
            break;
          }
        }
      }
    }

    // Find targeted bots that missed the message
    const missingTargetedBots: string[] = [];
    for (const phone of targetedBotPhones) {
      if (!tracker.receivedBy.has(phone)) {
        missingTargetedBots.push(phone);
      }
    }

    // Log results
    if (missingTargetedBots.length > 0) {
      console.log('\n══════════════════════════════════════════════════════════');
      console.log('MESSAGE CONSISTENCY CHECK');
      console.log('══════════════════════════════════════════════════════════');
      console.log(`Message ID: ${messageId}`);
      console.log(`Received by: ${tracker.receivedBy.size}/${this.config.allBotPhones.length} bots`);

      console.log('\n⚠ TARGETED bots that MISSED the message:');
      for (const phone of missingTargetedBots) {
        const botName = this.config.botPhoneToName.get(phone) || 'unknown';
        console.log(`  ✗ [${phone}] (${botName}) - WILL RECONNECT`);
      }

      // Reconnect and re-inject for each missing bot
      for (const phone of missingTargetedBots) {
        const botName = this.config.botPhoneToName.get(phone) || 'unknown';
        console.log(`  → Reconnecting [${phone}] (${botName}) and re-injecting message`);

        const wsHandler = this.config.wsHandlers.get(phone);
        const messageHandler = this.config.messageHandlers.get(phone);

        if (wsHandler && messageHandler) {
          // Force reconnect
          wsHandler.disconnect();
          wsHandler.connect();

          // Re-inject the message after a short delay for reconnection
          setTimeout(async () => {
            try {
              console.log(`  ✓ Re-processing message for ${botName}`);
              // Update botPhone to match the receiving bot
              const adjustedPayload = { ...tracker.messagePayload, botPhone: phone };
              await messageHandler(adjustedPayload);
            } catch (error: any) {
              console.error(`  ✗ Failed to re-process message for ${botName}:`, error.message);
            }
          }, 1000);
        } else {
          console.warn(`  ⚠ No handler found for ${phone}`);
        }
      }

      console.log('══════════════════════════════════════════════════════════\n');
    } else if (targetedBotPhones.size > 0) {
      // All targeted bots received it - log briefly
      const targetedNames = Array.from(targetedBotPhones)
        .map(p => this.config.botPhoneToName.get(p) || p)
        .join(', ');
      console.log(`✓ Message consistency OK: ${messageId.substring(0, 30)}... (targeted: ${targetedNames})`);
    }

    // Clean up
    this.messageTrackers.delete(messageId);
  }

  /**
   * Get stats for debugging
   */
  getStats(): { trackedMessages: number } {
    return {
      trackedMessages: this.messageTrackers.size
    };
  }

  /**
   * Stop all pending checks (for shutdown)
   */
  stop(): void {
    for (const tracker of this.messageTrackers.values()) {
      clearTimeout(tracker.timeout);
    }
    this.messageTrackers.clear();
  }
}
