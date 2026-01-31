/**
 * SignalReceiptReceptor - Handles Signal receipt events
 *
 * Processes read and delivery receipts from Signal CLI.
 * These are informational and don't trigger agent activation.
 */

import type { BotInstance } from '../types.js';
import type { SignalReceiptEvent } from './signal-websocket-receptor.js';

export interface SignalReceiptReceptorConfig {
  bot: BotInstance;
}

/**
 * SignalReceiptReceptor - Processes Signal receipts
 */
export class SignalReceiptReceptor {
  private bot: BotInstance;

  constructor(config: SignalReceiptReceptorConfig) {
    this.bot = config.bot;
  }

  /**
   * Handle receipt event
   */
  async handleReceipt(receipt: SignalReceiptEvent): Promise<void> {
    const botName = this.bot.config.name;

    // Log receipt (informational)
    console.log(`[SignalReceiptReceptor:${botName}] ${receipt.type} receipt from ${receipt.sender}`);

    try {
      // Emit to Connectome for state tracking (optional)
      await this.bot.grpcClient.emitSignalReceipt({
        type: receipt.type,
        sender: receipt.sender,
        senderNumber: receipt.senderNumber,
        senderUuid: receipt.senderUuid,
        timestamp: receipt.timestamp,
        botPhone: receipt.botPhone
      });
    } catch (error: any) {
      // Receipts are non-critical, just log and continue
      console.warn(`[SignalReceiptReceptor:${botName}] Failed to emit receipt:`, error.message);
    }
  }
}
