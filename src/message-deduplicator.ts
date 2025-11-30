/**
 * MessageDeduplicator - Prevents duplicate frame creation for group messages
 *
 * When multiple bots receive the same group message via independent WebSockets,
 * only the first bot to call shouldEmit() will emit an event. Others are skipped.
 *
 * This reduces frame creation from N (number of bots) to 1 per group message.
 *
 * DMs are not deduplicated (only one bot receives them anyway).
 * Re-processed messages from the consistency checker bypass deduplication.
 */

interface SeenMessage {
  firstReceiver: string;
  timestamp: number;
}

class MessageDeduplicator {
  private seenMessages = new Map<string, SeenMessage>();
  private readonly TTL = 10000; // 10 second window for deduplication
  private lastCleanup = Date.now();
  private readonly CLEANUP_INTERVAL = 5000; // Cleanup every 5 seconds

  /**
   * Check if this bot should emit an event for this message.
   *
   * @param messageId Unique message identifier (source-timestamp)
   * @param botPhone The bot phone number checking
   * @param isGroupMessage Whether this is a group message
   * @param isReprocessed Whether this is a re-processed message from consistency checker
   * @returns true if this bot should emit, false if another bot already emitted
   */
  shouldEmit(
    messageId: string,
    botPhone: string,
    isGroupMessage: boolean,
    isReprocessed: boolean = false
  ): boolean {
    // DMs always emit - only one bot receives them
    if (!isGroupMessage) {
      return true;
    }

    // Re-processed messages from consistency checker always emit
    // These are intentional re-triggers for bots that missed the original
    if (isReprocessed) {
      return true;
    }

    // Periodic cleanup of old entries
    this.cleanupIfNeeded();

    // Check if already seen
    const existing = this.seenMessages.get(messageId);
    if (existing) {
      // Another bot already emitted this message
      return false;
    }

    // First receiver - mark and allow emit
    this.seenMessages.set(messageId, {
      firstReceiver: botPhone,
      timestamp: Date.now()
    });

    return true;
  }

  /**
   * Get info about who first received a message (for debugging)
   */
  getFirstReceiver(messageId: string): string | undefined {
    return this.seenMessages.get(messageId)?.firstReceiver;
  }

  private cleanupIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.CLEANUP_INTERVAL) {
      return;
    }

    this.lastCleanup = now;
    const expiry = now - this.TTL;

    for (const [id, data] of this.seenMessages) {
      if (data.timestamp < expiry) {
        this.seenMessages.delete(id);
      }
    }
  }

  /**
   * Get current stats (for debugging)
   */
  getStats(): { trackedMessages: number; oldestTimestamp: number | null } {
    let oldest: number | null = null;
    for (const data of this.seenMessages.values()) {
      if (oldest === null || data.timestamp < oldest) {
        oldest = data.timestamp;
      }
    }
    return {
      trackedMessages: this.seenMessages.size,
      oldestTimestamp: oldest
    };
  }
}

// Singleton instance shared across all SignalAfferent instances
export const messageDeduplicator = new MessageDeduplicator();
