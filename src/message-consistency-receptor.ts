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
  // Callback to reconnect a bot's WebSocket and queue a message for re-processing
  reconnectBot: (botPhone: string, queuedMessage?: any) => void;
}

interface MessageTracker {
  messageId: string;
  timestamp: number;
  receivedBy: Set<string>;
  mentions: Array<{ uuid?: string; number?: string }>;
  quote?: { authorUuid?: string; author?: string }; // Quote info if message is a reply
  timeout: NodeJS.Timeout;
  messagePayload: any; // Store the full message payload for re-processing
  isBotMessage: boolean; // Whether this message is from another bot
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
    const { source, sourceUuid, timestamp, botPhone, mentions, quote, groupId } = payload;

    // Only check consistency for group messages
    if (!groupId) {
      return [];
    }

    // Check if the message is from a bot
    const isBotMessage = Array.from(this.config.botUuids.values()).includes(sourceUuid);

    const messageId = `${source}-${timestamp}`;

    // Get or create tracker for this message
    let tracker = this.messageTrackers.get(messageId);

    if (!tracker) {
      tracker = {
        messageId,
        timestamp,
        receivedBy: new Set(),
        mentions: mentions || [],
        quote: quote, // Track quote/reply info
        messagePayload: payload, // Store full payload for re-processing
        isBotMessage, // Track if this is a bot-to-bot message
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

    // Check if any mentioned or quoted bots missed the message
    const targetedMissingBots = new Set<string>();

    // Check mentions
    for (const mention of tracker.mentions) {
      const mentionUuid = mention.uuid;
      const mentionNumber = mention.number;

      // Find which bot was mentioned
      for (const [botPhone, botUuid] of this.config.botUuids.entries()) {
        if ((mentionUuid && mentionUuid === botUuid) ||
            (mentionNumber && mentionNumber === botPhone)) {
          if (missingBots.has(botPhone)) {
            targetedMissingBots.add(botPhone);
          }
          break;
        }
      }
    }

    // NOTE: Bot-to-bot mention triggering is handled by SignalMessageReceptor with loop prevention.
    // The consistency checker should NOT re-trigger bot mentions, only handle missed messages.
    // Previously this code would re-queue all mentioned bots, causing infinite loops.

    // Check quote/reply - if message quotes a bot, that bot should receive it
    if (tracker.quote) {
      const quoteAuthorUuid = tracker.quote.authorUuid;
      const quoteAuthor = tracker.quote.author;

      for (const [botPhone, botUuid] of this.config.botUuids.entries()) {
        if ((quoteAuthorUuid && quoteAuthorUuid === botUuid) ||
            (quoteAuthor && quoteAuthor === botPhone)) {
          if (missingBots.has(botPhone)) {
            console.log(`[MessageConsistencyReceptor] Quoted bot ${botPhone} (uuid: ${botUuid}) missed the message`);
            targetedMissingBots.add(botPhone);
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
      if (tracker.quote) {
        console.log(`Quote/Reply to: ${tracker.quote.authorUuid || tracker.quote.author}`);
      }

      if (targetedMissingBots.size > 0) {
        console.log('\n⚠ TARGETED bots (mentioned/quoted) that MISSED the message:');
        for (const phone of targetedMissingBots) {
          const botName = this.config.botNames.get(phone) || 'unknown';
          console.log(`  ✗ [${phone}] (${botName}) - WILL RECONNECT`);
        }

        // Reconnect targeted bots and queue the message for re-processing
        console.log(`\nReconnecting ${targetedMissingBots.size} targeted bot(s)...`);
        for (const botPhone of targetedMissingBots) {
          const botName = this.config.botNames.get(botPhone) || 'unknown';
          console.log(`  → Reconnecting [${botPhone}] (${botName}) and queueing message for re-processing`);
          // Pass the message payload so it can be re-processed after reconnection
          this.config.reconnectBot(botPhone, tracker.messagePayload);
        }
      }

      const otherMissing = new Set([...missingBots].filter(p => !targetedMissingBots.has(p)));
      if (otherMissing.size > 0) {
        console.log('\nOther bots that missed (not mentioned/quoted, ignoring):');
        for (const phone of otherMissing) {
          const botName = this.config.botNames.get(phone) || 'unknown';
          console.log(`  • [${phone}] (${botName})`);
        }
      }

      if (targetedMissingBots.size === 0) {
        console.log('\nℹ No targeted bots missed the message, no reconnection needed');
      }

      console.log('============================================================\n');
    } else {
      console.log(`✓ Message consistency OK: ${messageId.substring(0, 40)}... (${receivedBy.size}/${totalBots} bots)`);
    }

    // Clean up tracker
    this.messageTrackers.delete(messageId);
  }
}
