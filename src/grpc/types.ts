/**
 * Type definitions for Signal AXON gRPC mode
 */

import type { SignalGrpcClient } from './client.js';
import type { StreamManager } from './stream-manager.js';
import type { ToolLoopAgent } from '../tool-loop-agent.js';
import type { AnthropicToolProvider } from '../anthropic-tool-provider.js';
import type { BedrockProvider } from '../bedrock-provider.js';
import type { MCPServerConfig } from '@connectome/grpc-common';

/**
 * Bot configuration from config.json
 */
export interface BotConfig {
  name: string;
  phone?: string;
  uuid?: string;
  model?: string;
  prompt?: string;
  max_tokens?: number;
  persist_history?: boolean;
  tools?: string[];
  /** List of MCP server names this bot should use */
  mcp?: string[];
}

/**
 * Signal configuration from config.json
 */
export interface SignalConfig {
  bots: BotConfig[];
  /** Global MCP server configurations */
  mcp_servers?: MCPServerConfig[];
  group_privacy_mode?: 'opt-in' | 'opt-out';
  random_reply_chance?: number;
  max_bot_mentions_per_conversation?: number;
  max_conversation_frames?: number;
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
  agent?: ToolLoopAgent;
  llmProvider?: AnthropicToolProvider | BedrockProvider;
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
