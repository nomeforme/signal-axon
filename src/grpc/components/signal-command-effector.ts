/**
 * SignalCommandEffector - Handles ! commands
 *
 * Processes special commands (full parity with DiscordCommandEffector):
 * - !rr N - Set random reply chance (1 in N, 0 to disable)
 * - !bb N - Set max bot-to-bot interactions (0 to disable)
 * - !mcf N - Set max conversation frames
 * - !mmf N - Set max memory frames
 * - !mt N - Max output tokens per response (per-bot)
 * - !stop - Abort the current agent cycle
 * - !steer <message> - Redirect the running agent with a new instruction
 * - !stream in/out <name> - Enter/exit a named substream
 * - !autotrigger [on|off] [--stream <name>] [--max-speech-only <N>]
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
    // Preserve original case for args — only lowercase the command
    let cleaned = content.trim();

    // Strip leading @mention if present
    cleaned = cleaned.replace(/^@\S+\s+/, '').trim();

    if (!cleaned.startsWith('!')) return null;

    const parts = cleaned.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();

    console.log(`[SignalCommandEffector:${this.botName}] Handling command: ${command} args="${args}"`);

    switch (command) {
      case '!help':
        return this.handleHelp(currentConfig);

      case '!rr':
        return this.handleRandomReply(args, currentConfig, updateConfig);

      case '!bb':
        return this.handleBotToBotLimit(args, currentConfig, updateConfig);

      case '!mcf':
        return this.handleMaxConversationFrames(args, currentConfig, updateConfig);

      case '!mmf':
        return this.handleMaxMemoryFrames(args, currentConfig, updateConfig);

      case '!mt':
        return this.handleMaxTokens(args, emitEvent);

      case '!stop':
        return this.handleStop(emitEvent);

      case '!steer':
        return this.handleSteer(args, emitEvent);

      case '!autotrigger':
        return this.handleAutoTrigger(args, emitEvent);

      case '!stream':
        return this.handleStream(args, emitEvent);

      default:
        return null; // Not a recognized command
    }
  }

  private handleHelp(config: RuntimeConfig): string {
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

!stream in <name> - Enter a named substream
  !stream out <name> - Exit substream
  !stream - Show usage

!autotrigger [on|off] - Autonomous self-triggering loop
  --stream <name> - Shorthand: enter stream + enable autotrigger
  --max-speech-only <N> - Safety net: eject after N idle cycles (default: 5)

!help - Show this help`;
  }

  private handleRandomReply(
    args: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string {
    if (!args) {
      const chance = currentConfig.randomReplyChance;
      if (chance === 0) {
        return 'Random reply is currently disabled (0)';
      } else {
        const percentage = (100 / chance).toFixed(1);
        return `Random reply: 1/${chance} (${percentage}%)`;
      }
    }

    const newChance = parseInt(args);
    if (isNaN(newChance) || newChance < 0) {
      return 'Invalid value. Use a number >= 0 (0 = disabled, 1 = 100%, 10 = 10%, etc.)';
    }

    updateConfig({ randomReplyChance: newChance });

    if (newChance === 0) {
      return 'Random reply disabled';
    } else if (newChance === 1) {
      return 'Random reply set to 1/1 (100%) - bots will reply to every message';
    } else {
      const percentage = (100 / newChance).toFixed(1);
      return `Random reply set to 1/${newChance} (${percentage}%)`;
    }
  }

  private handleBotToBotLimit(
    args: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string {
    if (!args) {
      const limit = currentConfig.maxBotMentionsPerConversation;
      if (limit === 0) {
        return 'Bot-to-bot mentions are currently disabled (0)';
      } else {
        return `Bot-to-bot mention limit: ${limit}`;
      }
    }

    const newLimit = parseInt(args);
    if (isNaN(newLimit) || newLimit < 0) {
      return 'Invalid value. Use a number >= 0 (0 = disabled)';
    }

    updateConfig({ maxBotMentionsPerConversation: newLimit });

    if (newLimit === 0) {
      return 'Bot-to-bot mentions disabled';
    } else {
      return `Bot-to-bot mention limit set to ${newLimit}`;
    }
  }

  private handleMaxConversationFrames(
    args: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string {
    if (!args) {
      return `Max conversation frames: ${currentConfig.maxConversationFrames}`;
    }

    const newMaxFrames = parseInt(args);
    if (isNaN(newMaxFrames) || newMaxFrames < 10) {
      return 'Invalid value. Use a number >= 10';
    }

    updateConfig({ maxConversationFrames: newMaxFrames });
    return `Max conversation frames set to ${newMaxFrames}`;
  }

  private handleMaxMemoryFrames(
    args: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string {
    if (!args) {
      return `Max memory frames: ${currentConfig.maxMemoryFrames}`;
    }

    const newMaxMemFrames = parseInt(args);
    if (isNaN(newMaxMemFrames) || newMaxMemFrames < 10) {
      return 'Invalid value. Use a number >= 10';
    }

    updateConfig({ maxMemoryFrames: newMaxMemFrames });
    return `Max memory frames set to ${newMaxMemFrames}`;
  }

  private handleMaxTokens(args: string, emitEvent?: EmitEventCallback): string {
    if (!args) {
      if (this.maxOutputTokensOverride === undefined) {
        return `Max output tokens for ${this.botName}: using model default`;
      }
      return `Max output tokens for ${this.botName}: ${this.maxOutputTokensOverride}`;
    }

    const newMaxTokens = parseInt(args);
    if (isNaN(newMaxTokens) || newMaxTokens < 0) {
      return 'Invalid value. Use a number >= 0 (0 = reset to model default)';
    }

    const value = newMaxTokens === 0 ? undefined : newMaxTokens;
    this.maxOutputTokensOverride = value;

    if (emitEvent) {
      emitEvent('bot:config', {
        targetAgent: this.botName,
        maxOutputTokens: value ?? null,
      }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit config event:`, e.message));
    }

    if (value === undefined) {
      return `Max output tokens for ${this.botName} reset to model default`;
    }
    return `Max output tokens for ${this.botName} set to ${value}`;
  }

  private handleStop(emitEvent?: EmitEventCallback): string {
    if (emitEvent) {
      emitEvent('agent:command', {
        type: 'stop',
        targetAgent: this.botName,
      }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit stop:`, e.message));
    }
    return `Stopping ${this.botName}...`;
  }

  private handleSteer(args: string, emitEvent?: EmitEventCallback): string {
    if (!args) return 'Usage: !steer <message>';
    if (emitEvent) {
      emitEvent('agent:command', {
        type: 'steer',
        message: args,
        targetAgent: this.botName,
      }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit steer:`, e.message));
    }
    return `Steering ${this.botName}: ${args}`;
  }

  /**
   * Handle !autotrigger — enable/disable autonomous self-triggering loop
   *
   * Usage:
   *   !autotrigger              → enable autotrigger
   *   !autotrigger on           → enable autotrigger
   *   !autotrigger off          → disable autotrigger
   *   !autotrigger --stream X   → shorthand: enter substream + enable autotrigger
   *   !autotrigger --max-speech-only N → safety net: eject after N idle cycles
   */
  private handleAutoTrigger(args: string, emitEvent?: EmitEventCallback): string {
    const parts = args.split(/\s+/).filter(Boolean);
    let enable = true;
    let substreamName: string | undefined;
    let maxSpeechOnly: number | undefined;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].toLowerCase();
      if (part === 'off') {
        enable = false;
      } else if (part === 'on') {
        enable = true;
      } else if (part === '--stream' && i + 1 < parts.length) {
        substreamName = parts[i + 1];
        i++;
      } else if (part === '--max-speech-only' && i + 1 < parts.length) {
        const val = parseInt(parts[i + 1], 10);
        if (!isNaN(val) && val > 0) maxSpeechOnly = val;
        i++;
      }
    }

    if (emitEvent) {
      // If --stream was specified and enabling, emit substream command FIRST
      if (substreamName && enable) {
        emitEvent('agent:command', {
          type: 'workflow',
          targetAgent: this.botName,
          enable: true,
          workflowName: substreamName,
        }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit substream:`, e.message));
      }

      emitEvent('agent:command', {
        type: 'autotrigger',
        targetAgent: this.botName,
        enable,
        maxSpeechOnly,
      }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit autotrigger:`, e.message));
    }

    if (!enable) {
      return `Autotrigger disabled for ${this.botName}`;
    }
    const ssMsg = substreamName ? ` (substream: ${substreamName})` : '';
    const msoMsg = maxSpeechOnly ? `, max-speech-only: ${maxSpeechOnly}` : '';
    return `Autotrigger enabled for ${this.botName}${ssMsg}${msoMsg} — use !stop to halt`;
  }

  /**
   * Handle !stream — enter/exit a named substream
   *
   * Usage:
   *   !stream in <name>   → enter substream
   *   !stream out <name>  → exit substream
   *   !stream             → show usage
   */
  private handleStream(args: string, emitEvent?: EmitEventCallback): string {
    const parts = args.split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
      return 'Usage: !stream in <name> to enter, !stream out <name> to exit.';
    }

    const direction = parts[0].toLowerCase();

    if (direction === 'out') {
      if (emitEvent) {
        emitEvent('agent:command', {
          type: 'workflow',
          targetAgent: this.botName,
          enable: false,
        }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit stream out:`, e.message));
      }
      return `Substream exited for ${this.botName}`;
    }

    if (direction === 'in' && parts.length >= 2) {
      const substreamName = parts[1];
      if (emitEvent) {
        emitEvent('agent:command', {
          type: 'workflow',
          targetAgent: this.botName,
          enable: true,
          workflowName: substreamName,
        }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit stream in:`, e.message));
      }
      return `Substream "${substreamName}" entered for ${this.botName}`;
    }

    return 'Usage: !stream in <name> to enter, !stream out <name> to exit.';
  }
}
