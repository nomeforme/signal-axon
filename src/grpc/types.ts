/**
 * Type definitions for Signal AXON gRPC mode
 *
 * Bot identities are discovered from signal-cli, not from static config.
 */

import type { SignalGrpcClient } from './client.js';
import type { StreamManager } from './stream-manager.js';

/**
 * Bot configuration — discovered from signal-cli + env vars
 *
 * name comes from signal-cli profile or SIGNAL_BOT_NAMES env.
 * phone comes from BOT_PHONE_NUMBERS env.
 * uuid comes from signal-cli accounts.json.
 * All cognition fields live in bot-runtime config.
 */
export interface BotConfig {
  name: string;
  phone?: string;
  uuid?: string;
  agentName?: string;  // from platform binding — matches bot-runtime's BOT_NAME
}

/**
 * Runtime configuration (from env vars with defaults, tunable via ! commands)
 */
export interface RuntimeConfig {
  randomReplyChance: number;
  maxBotMentionsPerConversation: number;
  maxConversationFrames: number;
  maxMemoryFrames: number;
  groupPrivacyMode: 'opt-in' | 'opt-out';
  /**
   * Outbound message split threshold (characters).
   * - N > 0:  split at N chars on paragraph/sentence/word boundaries (default 400)
   * - 0:      "native" mode — send the whole message in one shot up to Signal's
   *           hard ~4096-char limit, letting Signal's built-in "see more" handle
   *           the display rather than fragmenting into many sub-messages.
   * Tunable at runtime via `!split [N|auto|native|off]`.
   */
  messageSplitThreshold: number;
}

/**
 * Runtime bot instance
 */
export interface BotInstance {
  config: BotConfig;
  grpcClient: SignalGrpcClient;
  streamManager: StreamManager;
}

/**
 * Shared state across all bot instances
 */
export interface SharedState {
  /** Map from bot phone to bot instance */
  bots: Map<string, BotInstance>;
  /** Map from bot UUID to bot name (populated from signal-cli) */
  botUuidToName: Map<string, string>;
  /** Map from any UUID to display name (bots + humans, for mention resolution) */
  uuidToName: Map<string, string>;
  /** Map from bot phone to bot name */
  botPhoneToName: Map<string, string>;
  /** Track activations currently being processed (dedup) */
  processingActivations: Set<string>;
  /** Track bot-to-bot interaction counts per stream */
  botInteractionCounts: Map<string, number>;
  /** Runtime configuration */
  runtimeConfig: RuntimeConfig;
}

/**
 * Signal message event payload
 */
export interface SignalMessageEvent {
  content: string;
  sender: string;
  senderNumber?: string;
  senderUuid?: string;
  groupId?: string;
  groupName?: string;
  botPhone: string;
  timestamp: number;
  attachments?: SignalAttachment[];
  mentions?: SignalMention[];
  quotedMessage?: SignalQuote;
}

/**
 * Signal attachment
 */
export interface SignalAttachment {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
  data?: string;  // base64 encoded
}

/**
 * Signal mention (position-based) - for INCOMING messages
 */
export interface SignalMention {
  start: number;
  length: number;
  uuid: string;
}

/**
 * Signal mention for OUTGOING messages - Signal CLI API expects phone number
 */
export interface SignalOutgoingMention {
  start: number;
  length: number;
  author: string;  // phone number, NOT uuid
}

/**
 * Signal quote/reply
 */
export interface SignalQuote {
  id: number;
  author: string;
  authorUuid?: string;
  text?: string;
}
