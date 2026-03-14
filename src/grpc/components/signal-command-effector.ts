/**
 * SignalCommandEffector - Handles ! commands
 *
 * Processes special commands:
 * - !rr N - Set random reply chance (1 in N, 0 to disable)
 * - !bb N - Set max bot-to-bot interactions (0 to disable)
 * - !mcf N - Set max conversation frames
 * - !mmf N - Set max memory frames
 * - !stop - Abort the current agent cycle
 * - !steer <message> - Redirect the running agent with a new instruction
 * - !help - Show help
 */

import type { RuntimeConfig } from '../types.js';

export type ConfigUpdateCallback = (updates: Partial<RuntimeConfig>) => void;
export type EmitEventCallback = (topic: string, payload: Record<string, any>) => Promise<any>;

/**
 * SignalCommandEffector - Handles ! commands
 *
 * Constraint equivalent: EFFECTOR priority (but synchronous, returns immediately)
 */
export class SignalCommandEffector {
  private botName: string;
  /** Tracks the last-set maxOutputTokens override (axon-local, per command effector instance) */
  private maxOutputTokensOverride: number | undefined;

  constructor(botName: string) {
    this.botName = botName;
  }

  /**
   * Handle a command message
   *
   * @param content - Message content (starting with !)
   * @param currentConfig - Current runtime config
   * @param updateConfig - Callback to update config
   * @param emitEvent - Optional callback to emit events to Connectome (for per-bot config commands)
   * @returns Response message, or null if not a recognized command
   */
  handleCommand(
    content: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback,
    emitEvent?: EmitEventCallback
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

      case '!mt': {
        if (!arg) {
          if (this.maxOutputTokensOverride === undefined) {
            return `Max output tokens for ${this.botName}: using model default`;
          }
          return `Max output tokens for ${this.botName}: ${this.maxOutputTokensOverride}`;
        }
        const value = parseInt(arg);
        if (isNaN(value) || value < 0) return 'Invalid value. Use a number >= 0 (0 = reset to model default)';
        const effective = value === 0 ? undefined : value;
        this.maxOutputTokensOverride = effective;
        if (emitEvent) {
          emitEvent('bot:config', {
            targetAgent: this.botName,
            maxOutputTokens: effective ?? null,
          }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit config event:`, e.message));
        }
        return effective === undefined
          ? `Max output tokens for ${this.botName} reset to model default`
          : `Max output tokens for ${this.botName} set to ${effective}`;
      }

      case '!stop': {
        if (emitEvent) {
          emitEvent('agent:command', {
            type: 'stop',
            targetAgent: this.botName,
          }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit stop:`, e.message));
        }
        return `Stopping ${this.botName}...`;
      }

      case '!steer': {
        const steerMsg = parts.slice(1).join(' ').trim();
        if (!steerMsg) return 'Usage: !steer <message>';
        if (emitEvent) {
          emitEvent('agent:command', {
            type: 'steer',
            message: steerMsg,
            targetAgent: this.botName,
          }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit steer:`, e.message));
        }
        return `Steering ${this.botName}: ${steerMsg}`;
      }

      case '!autotrigger': {
        const atArg = parts[1]?.toLowerCase();
        const enable = atArg !== 'off';
        // Check for --workflow flag
        const wfIdx = parts.indexOf('--workflow');
        const workflowName = wfIdx >= 0 && parts[wfIdx + 1] ? parts[wfIdx + 1] : undefined;
        if (emitEvent) {
          emitEvent('agent:command', {
            type: 'autotrigger',
            targetAgent: this.botName,
            enable,
            workflowName,
          }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit autotrigger:`, e.message));
        }
        if (!enable) return `Autotrigger disabled for ${this.botName}`;
        const wfMsg = workflowName ? ` (workflow: ${workflowName})` : '';
        return `Autotrigger enabled for ${this.botName}${wfMsg} — use !stop to halt`;
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

!mt [N] - Max output tokens per response (per-bot, 0=model default)
  Current: ${this.maxOutputTokensOverride ?? 'model default'}

!stop - Abort the current agent cycle
!steer <message> - Redirect the running agent mid-cycle

!autotrigger [on|off] [--workflow <name>] - Autonomous self-triggering loop

!help - Show this help`;
  }
}
