/**
 * SignalCommandEffector - Handles ! commands
 *
 * Processes special commands:
 * - !rr N - Set random reply chance (1 in N, 0 to disable)
 * - !bb N - Set max bot-to-bot interactions (0 to disable)
 * - !mcf N - Set max conversation frames
 * - !mmf N - Set max memory frames
 * - !help - Show help
 */

import type { RuntimeConfig } from '../types.js';

export type ConfigUpdateCallback = (updates: Partial<RuntimeConfig>) => void;

/**
 * SignalCommandEffector - Handles ! commands
 *
 * Constraint equivalent: EFFECTOR priority (but synchronous, returns immediately)
 */
export class SignalCommandEffector {
  private botName: string;

  constructor(botName: string) {
    this.botName = botName;
  }

  /**
   * Handle a command message
   *
   * @param content - Message content (starting with !)
   * @param currentConfig - Current runtime config
   * @param updateConfig - Callback to update config
   * @returns Response message, or null if not a recognized command
   */
  handleCommand(
    content: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string | null {
    const trimmed = content.trim().toLowerCase();

    // Parse command and optional argument
    const parts = trimmed.split(/\s+/);
    const command = parts[0];
    const arg = parts[1];

    switch (command) {
      case '!rr': {
        if (!arg) {
          // Show current setting
          const chance = currentConfig.randomReplyChance;
          return chance === 0
            ? 'Random reply is currently disabled (0)'
            : `Random reply: 1/${chance} (${(100 / chance).toFixed(1)}%)`;
        }
        const value = parseInt(arg);
        if (isNaN(value)) return null;
        updateConfig({ randomReplyChance: value });
        return value === 0
          ? `Random replies disabled`
          : `Random reply chance set to 1 in ${value}`;
      }

      case '!bb': {
        if (!arg) {
          // Show current setting
          const limit = currentConfig.maxBotMentionsPerConversation;
          return limit === 0
            ? 'Bot-to-bot limiting is disabled (unlimited)'
            : `Bot-to-bot limit: ${limit} interactions per conversation`;
        }
        const value = parseInt(arg);
        if (isNaN(value)) return null;
        updateConfig({ maxBotMentionsPerConversation: value });
        return value === 0
          ? `Bot-to-bot limiting disabled`
          : `Max bot-to-bot interactions set to ${value}`;
      }

      case '!mcf': {
        if (!arg) {
          return `Max conversation frames: ${currentConfig.maxConversationFrames}`;
        }
        const value = parseInt(arg);
        if (isNaN(value)) return null;
        updateConfig({ maxConversationFrames: value });
        return `Max conversation frames set to ${value}`;
      }

      case '!mmf': {
        if (!arg) {
          return `Max memory frames: ${currentConfig.maxMemoryFrames}`;
        }
        const value = parseInt(arg);
        if (isNaN(value)) return null;
        updateConfig({ maxMemoryFrames: value });
        return `Max memory frames set to ${value}`;
      }

      case '!help':
        return this.getHelpText(currentConfig);

      default:
        // Not a recognized command
        return null;
    }
  }

  /**
   * Get help text
   */
  private getHelpText(config: RuntimeConfig): string {
    return `Signal AXON Commands (use without argument to show current value):

!rr [N] - Random reply chance (1 in N, 0=disabled)
  Current: ${config.randomReplyChance === 0 ? 'disabled' : `1 in ${config.randomReplyChance}`}

!bb [N] - Max bot-to-bot interactions (0=unlimited)
  Current: ${config.maxBotMentionsPerConversation === 0 ? 'unlimited' : config.maxBotMentionsPerConversation}

!mcf [N] - Max conversation frames
  Current: ${config.maxConversationFrames}

!mmf [N] - Max memory frames
  Current: ${config.maxMemoryFrames}

!help - Show this help`;
  }
}
