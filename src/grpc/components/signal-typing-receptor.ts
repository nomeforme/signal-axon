/**
 * SignalTypingReceptor - Handles Signal typing indicators
 *
 * Processes typing started/stopped events from Signal CLI.
 * These are informational and don't trigger agent activation.
 */

import type { BotInstance } from '../types.js';
import type { SignalTypingEvent } from './signal-websocket-receptor.js';

export interface SignalTypingReceptorConfig {
  bot: BotInstance;
}

/**
 * SignalTypingReceptor - Processes Signal typing indicators
 */
export class SignalTypingReceptor {
  private bot: BotInstance;

  constructor(config: SignalTypingReceptorConfig) {
    this.bot = config.bot;
  }

  /**
   * Handle typing event
   */
  async handleTyping(typing: SignalTypingEvent): Promise<void> {
    const botName = this.bot.config.name;

    // Log typing (debug level - too frequent for normal logs)
    // console.log(`[SignalTypingReceptor:${botName}] ${typing.sender} ${typing.started ? 'started' : 'stopped'} typing`);

    try {
      // Emit to Connectome for state tracking (optional)
      await this.bot.grpcClient.emitSignalTyping({
        sender: typing.sender,
        groupId: typing.groupId,
        started: typing.started,
        timestamp: typing.timestamp,
        botPhone: typing.botPhone
      });
    } catch (error: any) {
      // Typing indicators are non-critical, just continue
    }
  }
}
