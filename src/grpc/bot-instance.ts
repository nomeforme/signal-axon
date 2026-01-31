/**
 * Bot instance management for Signal AXON gRPC mode
 * Handles creation and setup of individual bot instances
 */

import { SignalGrpcClient } from './client.js';
import { StreamManager } from './stream-manager.js';
import { ToolLoopAgent, createFetchTool } from '../tool-loop-agent.js';
import type { ToolHandler } from '../tool-loop-agent.js';
import { AnthropicToolProvider } from '../anthropic-tool-provider.js';
import { BedrockProvider } from '../bedrock-provider.js';
import type { BotConfig, BotInstance } from './types.js';

/**
 * Create LLM provider based on model name
 */
function createLlmProvider(
  modelName: string,
  maxTokens: number
): AnthropicToolProvider | BedrockProvider | undefined {
  const isBedrockModel = modelName.startsWith('bedrock-') || modelName.startsWith('us.') || modelName.startsWith('eu.');

  if (isBedrockModel) {
    return new BedrockProvider({
      region: process.env.AWS_REGION || 'us-east-1',
      defaultModel: modelName,
      defaultMaxTokens: maxTokens
    });
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      return new AnthropicToolProvider({
        apiKey,
        defaultModel: modelName,
        defaultMaxTokens: maxTokens
      });
    }
  }

  return undefined;
}

/**
 * Create a bot instance (without connecting)
 */
export function createBotInstance(
  botConfig: BotConfig,
  grpcHost: string,
  grpcPort: number
): BotInstance {
  const botPhone = botConfig.phone!;

  // Create gRPC client for this bot
  const grpcClient = new SignalGrpcClient({
    serverHost: grpcHost,
    serverPort: grpcPort,
    clientId: `signal-${botPhone}`,
    botName: botConfig.name
  });

  // Create stream manager for this bot
  const streamManager = new StreamManager(grpcClient);

  // Create the instance
  const botInstance: BotInstance = {
    config: botConfig,
    grpcClient,
    streamManager
  };

  // Create LLM provider and ToolLoopAgent
  const modelName = botConfig.model || 'claude-sonnet-4-20250514';
  const maxTokens = botConfig.max_tokens || 4096;
  const llmProvider = createLlmProvider(modelName, maxTokens);

  if (llmProvider) {
    botInstance.llmProvider = llmProvider;

    // Use exact same prompt logic as non-gRPC version
    const systemPrompt = botConfig.prompt || 'Standard';

    // Build tools list from config
    const agentTools: ToolHandler[] = [];
    if (botConfig.tools?.includes('fetch')) {
      agentTools.push(createFetchTool());
      console.log(`  ${botConfig.name}: fetch tool enabled`);
    }

    // Pass a stub object - ToolLoopAgent stores veilStateManager but never uses it
    const dummyVeilState = {} as any;
    botInstance.agent = new ToolLoopAgent(
      {
        name: botConfig.name,
        systemPrompt,
        defaultMaxTokens: maxTokens,
        tools: agentTools
      },
      llmProvider,
      dummyVeilState
    );
    console.log(`  Created ToolLoopAgent for ${botConfig.name} (${modelName})`);
  } else {
    console.warn(`  No LLM provider for ${botConfig.name} - agent responses disabled`);
  }

  return botInstance;
}
