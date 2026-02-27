/**
 * Type definitions for Signal AXON gRPC mode
 */

import type { SignalGrpcClient } from './client.js';
import type { StreamManager } from './stream-manager.js';

/**
 * Bot configuration from config.json
 *
 * All cognition fields (model, tools, mcp, skills, rlm, etc.) live in
 * bot-runtime/config.json. The axon only needs identity + platform binding.
 */
export interface BotConfig {
  name: string;
  phone?: string;
  uuid?: string;
  prompt?: string;
  /** Skip the platform identity text in system prompt */
  skip_identity_prompt?: boolean;
  /** Remote mode: cognition delegated to bot-runtime (all bots are remote) */
  remote?: boolean;
}

/**
 * Signal configuration from config.json
 */
export interface SignalConfig {
  bots: BotConfig[];
  group_privacy_mode?: 'opt-in' | 'opt-out';
  random_reply_chance?: number;
  max_bot_mentions_per_conversation?: number;
  max_conversation_frames?: number;
  max_message_length?: number;
}

/**
 * Runtime configuration for commands (shared across all bots)
 */
export interface RuntimeConfig {
  randomReplyChance: number;
  maxBotMentionsPerConversation: number;
  maxConversationFrames: number;
  maxMemoryFrames: number;
  groupPrivacyMode: 'opt-in' | 'opt-out';
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
  /** Map from bot UUID to bot name (for mention-based routing) */
  botUuidToName: Map<string, string>;
  /** Map from bot phone to bot name */
  botPhoneToName: Map<string, string>;
  /** Track activations currently being processed (dedup) */
  processingActivations: Set<string>;
  /** Track bot-to-bot interaction counts per stream */
  botInteractionCounts: Map<string, number>;
  /** Runtime configuration */
  runtimeConfig: RuntimeConfig;
  /** All paired bot configs (for iteration) */
  pairedBots: BotConfig[];
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
