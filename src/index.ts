/**
 * Signal AXON Module for Connectome
 *
 * Exports gRPC components for Signal messenger integration
 */

// Re-export everything from gRPC module
export * from './grpc/index.js';

// Also export message deduplicator (shared utility)
export { messageDeduplicator } from './message-deduplicator.js';

// Export LLM providers (shared with discord-axon)
export { ToolLoopAgent, createFetchTool } from './tool-loop-agent.js';
export type { ToolHandler, ToolLoopAgentConfig } from './tool-loop-agent.js';
export { AnthropicToolProvider } from './anthropic-tool-provider.js';
export type { AnthropicToolProviderConfig, ToolSchema, ToolLLMOptions, ToolLLMResponse } from './anthropic-tool-provider.js';
export { BedrockProvider } from './bedrock-provider.js';
export type { BedrockProviderConfig } from './bedrock-provider.js';
