/**
 * SignalCommandEffector - Handles ! commands
 *
 * Processes special commands (full parity with DiscordCommandEffector):
 * - !rr N - Set random reply chance (1 in N, 0 to disable)
 * - !bb N - Set max bot-to-bot interactions (0 to disable)
 * - !mcf N - Set max conversation frames
 * - !mmf N - Set max memory frames
 * - !mt N - Max output tokens per response (per-bot)
 * - !split [N|auto|native|off] - Outbound message split threshold (axon-wide)
 * - !continue - Continue from the bot's last message (prefill)
 * - !stop - Abort the current agent cycle
 * - !steer <message> - Redirect the running agent with a new instruction
 * - !stream in/out <name> - Enter/exit a named substream
 * - !autotrigger [on|off] [--stream <name>] [--max-speech-only <N>]
 * - !help - Show help
 */

import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import type { RuntimeConfig } from '../types.js';

const SECRETS_DIR = '/workspace/shared/secrets';

export type ConfigUpdateCallback = (updates: Partial<RuntimeConfig>) => void;
export type EmitEventCallback = (topic: string, payload: Record<string, any>) => Promise<any>;

/**
 * SignalCommandEffector - Handles ! commands
 *
 * Constraint equivalent: EFFECTOR priority (but synchronous, returns immediately)
 */
export interface SignalCommandEffectorOptions {
  /** Default messageSplitThreshold (from env / operational config) — what `!split auto` restores. */
  messageSplitThresholdDefault: number;
}

export class SignalCommandEffector {
  private botName: string;
  /** Tracks the last-set maxOutputTokens override (axon-local, per command effector instance) */
  private maxOutputTokensOverride: number | undefined;
  /** Tracks the last-set historyDefault override (mirrors bot-runtime's ConnectomeBridge state). */
  private historyDefaultOverride: number | undefined;
  /** Default value for `!split auto` — captured at axon startup. */
  private messageSplitThresholdDefault: number;

  constructor(botName: string, opts: SignalCommandEffectorOptions) {
    this.botName = botName;
    this.messageSplitThresholdDefault = opts.messageSplitThresholdDefault;
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

      case '!h-default':
        return this.handleHistoryDefault(args, emitEvent);

      case '!split':
        return this.handleSplit(args, currentConfig, updateConfig);

      case '!stop':
        return this.handleStop(emitEvent);

      case '!steer':
        return this.handleSteer(args, emitEvent);

      case '!autotrigger':
        return this.handleAutoTrigger(args, emitEvent);

      case '!stream':
        return this.handleStream(args, emitEvent);

      case '!secret':
        return this.handleSecret(args);

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

!h-default [N|off] - Persistent history trim (per-bot). Applies !hN to every activation.
  Current: ${this.historyDefaultOverride === undefined ? 'off (full history)' : `${this.historyDefaultOverride} history + trigger`}
  Per-message override: prefix a message with !h<N> for one-shot trim.

!split [N|auto|native|off] - Outbound message split threshold (axon-wide)
  N         → split long replies at N chars on paragraph/sentence/word boundaries
  auto      → restore the env default (${this.messageSplitThresholdDefault})
  native|off → no aggressive split — send full message, let Signal's "see more" handle it
  Current: ${config.messageSplitThreshold === 0 ? 'native (no split)' : `${config.messageSplitThreshold} chars`}

!continue - Continue from the bot's last message (prefill)
  Also: m continue, m go, m more
!stop - Abort the current agent cycle
!steer <message> - Redirect the running agent mid-cycle

!stream in <name> - Enter a named substream
  !stream out <name> - Exit substream
  !stream - Show usage

!autotrigger [on|off] - Autonomous self-triggering loop
  --stream <name> - Shorthand: enter stream + enable autotrigger
  --max-speech-only <N> - Safety net: eject after N idle cycles (default: 5)

!secret <name> <value> - Store a secret (never reaches VEIL)
  !secret list - List stored secret names
  !secret delete <name> - Remove a secret
  Bots use inject_secret tool to pipe to remote .env files

!help - Show this help`;
  }

  private handleSecret(args: string): string | null {
    try {
      mkdirSync(SECRETS_DIR, { recursive: true });
    } catch { /* already exists */ }

    if (!args || args === 'list') {
      try {
        const files = readdirSync(SECRETS_DIR);
        if (files.length === 0) return 'No secrets stored.';
        return `Stored secrets: ${files.join(', ')}`;
      } catch {
        return 'No secrets stored.';
      }
    }

    if (args.startsWith('delete ')) {
      const name = args.slice(7).trim();
      if (!name) return 'Usage: !secret delete <name>';
      try {
        unlinkSync(join(SECRETS_DIR, name));
        return `Deleted secret: ${name}`;
      } catch {
        return `Secret not found: ${name}`;
      }
    }

    const spaceIdx = args.indexOf(' ');
    if (spaceIdx === -1) return 'Usage: !secret <name> <value>';

    const name = args.slice(0, spaceIdx).trim();
    const value = args.slice(spaceIdx + 1).trim();

    if (!name || !value) return 'Usage: !secret <name> <value>';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return 'Secret name must be alphanumeric/underscore.';

    try {
      writeFileSync(join(SECRETS_DIR, name), value, { mode: 0o600 });
      return `Secret stored: ${name} (${value.length} chars)`;
    } catch (err: any) {
      return `Error storing secret: ${err.message}`;
    }
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

  /**
   * !h-default — persistent history trim default. When set, every activation
   * on this bot trims the API context to the last N+1 messages (N history +
   * trigger), same as prefixing every message with !h<N>. `off` disables.
   * Individual messages can still use !h<N> to override for that turn only.
   */
  private handleHistoryDefault(args: string, emitEvent?: EmitEventCallback): string {
    if (!args) {
      return this.historyDefaultOverride === undefined
        ? `History default for ${this.botName}: off (full history sent)`
        : `History default for ${this.botName}: ${this.historyDefaultOverride} messages of prior history`;
    }

    const lower = args.toLowerCase();
    let value: number | undefined;
    if (lower === 'off' || lower === 'disable' || lower === 'none') {
      value = undefined;
    } else {
      const n = parseInt(args, 10);
      if (isNaN(n) || n < 0) {
        return 'Usage: !h-default <N|off> (N >= 0 for last-N-messages of history)';
      }
      value = n;
    }
    this.historyDefaultOverride = value;

    if (emitEvent) {
      emitEvent('bot:config', {
        targetAgent: this.botName,
        historyDefault: value ?? null,
      }).catch((e: any) => console.error(`[SignalCommandEffector:${this.botName}] Failed to emit h-default:`, e.message));
    }

    return value === undefined
      ? `History default for ${this.botName} disabled — full history sent to API`
      : `History default for ${this.botName} set to ${value} (each activation trims to last ${value} + trigger)`;
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

  /**
   * Handle !split — outbound message split threshold (axon-wide, runtime-tunable).
   *
   * Usage:
   *   !split             → show current threshold
   *   !split N           → split long replies at N chars (paragraph/sentence/word breaks)
   *   !split auto        → restore the env-configured default
   *   !split native      → disable splitting (whole message in one shot, "see more" handles display)
   *   !split off         → alias for native
   *   !split 0           → alias for native
   */
  private handleSplit(
    args: string,
    currentConfig: RuntimeConfig,
    updateConfig: ConfigUpdateCallback
  ): string {
    if (!args) {
      const cur = currentConfig.messageSplitThreshold;
      if (cur === 0) {
        return `Message split: native (no aggressive splitting; Signal "see more" handles long messages). Default: ${this.messageSplitThresholdDefault} chars.`;
      }
      return `Message split threshold: ${cur} chars. Default: ${this.messageSplitThresholdDefault} chars.`;
    }

    const arg = args.toLowerCase();
    let newThreshold: number;

    if (arg === 'auto') {
      newThreshold = this.messageSplitThresholdDefault;
    } else if (arg === 'native' || arg === 'off') {
      newThreshold = 0;
    } else {
      const n = parseInt(arg, 10);
      if (isNaN(n) || n < 0) {
        return 'Invalid value. Use: !split N (N>=0) | !split auto | !split native | !split off';
      }
      newThreshold = n;
    }

    updateConfig({ messageSplitThreshold: newThreshold });

    if (newThreshold === 0) {
      return 'Message split disabled — full message sent in one shot (capped at Signal\'s 4096 limit). Users will see "see more" for long content.';
    }
    return `Message split threshold set to ${newThreshold} chars.`;
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
