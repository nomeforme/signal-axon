/**
 * MessageConsistencyReceptor - Ensures mentioned bots receive messages
 *
 * Tracks which bots receive each message and triggers reconnection
 * if a mentioned bot didn't receive it.
 */

import { BaseReceptor } from 'connectome-ts';
import type { SpaceEvent, VEILDelta, ReadonlyVEILState } from 'connectome-ts';

export interface MessageConsistencyConfig {
  // Map of bot phone numbers to their names
  botNames: Map<string, string>;
  // Map of bot phone numbers to their UUIDs
  botUuids: Map<string, string>;
  // Callback to reconnect a bot's WebSocket
  reconnectBot: (botPhone: string) => void;
}

interface MessageTracker {
  messageId: string;
  timestamp: number;
  receivedBy: Set<string>;
  mentions: Array<{ uuid?: string; number?: string }>;
  timeout: NodeJS.Timeout;
}

export class MessageConsistencyReceptor extends BaseReceptor {
  topics = ['signal:message'];

  private config: MessageConsistencyConfig;
  private messageTrackers = new Map<string, MessageTracker>();
  private readonly CONSISTENCY_CHECK_DELAY = 2000; // 2 seconds to wait for all bots

  constructor(config: MessageConsistencyConfig) {
    super();
    this.config = config;
  }

  transform(event: SpaceEvent, state: ReadonlyVEILState): VEILDelta[] {
    const payload = event.payload as any;
    const { source, timestamp, botPhone, mentions, groupId } = payload;

    // Only check consistency for group messages
    if (!groupId) {
      return [];
    }

    const messageId = `${source}-${timestamp}`;

    // Get or create tracker for this message
    let tracker = this.messageTrackers.get(messageId);

    if (!tracker) {
      tracker = {
        messageId,
        timestamp,
        receivedBy: new Set(),
        mentions: mentions || [],
        timeout: setTimeout(() => this.checkConsistency(messageId), this.CONSISTENCY_CHECK_DELAY)
      };
      this.messageTrackers.set(messageId, tracker);
    }

    // Record that this bot received the message
    tracker.receivedBy.add(botPhone);

    return [];
  }

  private checkConsistency(messageId: string): void {
    const tracker = this.messageTrackers.get(messageId);
    if (!tracker) return;

    const totalBots = this.config.botNames.size;
    const receivedBy = tracker.receivedBy;
    const missingBots = new Set<string>();

    // Find which bots didn't receive the message
    for (const botPhone of this.config.botNames.keys()) {
      if (!receivedBy.has(botPhone)) {
        missingBots.add(botPhone);
      }
    }

    // Check if any mentioned bots missed the message
    const mentionedMissingBots = new Set<string>();
    for (const mention of tracker.mentions) {
      const mentionUuid = mention.uuid;
      const mentionNumber = mention.number;

      // Find which bot was mentioned
      for (const [botPhone, botUuid] of this.config.botUuids.entries()) {
        if ((mentionUuid && mentionUuid === botUuid) ||
            (mentionNumber && mentionNumber === botPhone)) {
          if (missingBots.has(botPhone)) {
            mentionedMissingBots.add(botPhone);
          }
          break;
        }
      }
    }

    // Log results
    if (missingBots.size > 0) {
      console.log('\n============================================================');
      console.log('MESSAGE CONSISTENCY CHECK');
      console.log('============================================================');
      console.log(`Message ID: ${messageId}`);
      console.log(`Received by: ${receivedBy.size}/${totalBots} bots`);

      if (mentionedMissingBots.size > 0) {
        console.log('\n⚠ MENTIONED bots that MISSED the message:');
        for (const phone of mentionedMissingBots) {
          const botName = this.config.botNames.get(phone) || 'unknown';
          console.log(`  ✗ [${phone}] (${botName}) - WILL RECONNECT`);
        }

        // Reconnect mentioned bots
        console.log(`\nReconnecting ${mentionedMissingBots.size} mentioned bot(s)...`);
        for (const botPhone of mentionedMissingBots) {
          const botName = this.config.botNames.get(botPhone) || 'unknown';
          console.log(`  → Reconnecting [${botPhone}] (${botName})`);
          this.config.reconnectBot(botPhone);
        }
      }

      const otherMissing = new Set([...missingBots].filter(p => !mentionedMissingBots.has(p)));
      if (otherMissing.size > 0) {
        console.log('\nOther bots that missed (not mentioned, ignoring):');
        for (const phone of otherMissing) {
          const botName = this.config.botNames.get(phone) || 'unknown';
          console.log(`  • [${phone}] (${botName})`);
        }
      }

      if (mentionedMissingBots.size === 0) {
        console.log('\nℹ No mentioned bots missed the message, no reconnection needed');
      }

      console.log('============================================================\n');
    } else {
      console.log(`✓ Message consistency OK: ${messageId.substring(0, 40)}... (${receivedBy.size}/${totalBots} bots)`);
    }

    // Clean up tracker
    this.messageTrackers.delete(messageId);
  }
}
