/**
 * Bot instance management for Signal AXON gRPC mode
 * Handles creation and setup of individual bot instances
 */

import { SignalGrpcClient } from './client.js';
import { StreamManager } from './stream-manager.js';
import { ConnectomeAgent, resolveModel } from '@connectome/agent-core';
import type { ToolHandler } from '@connectome/agent-core';
import { createFetchTool } from '../tool-loop-agent.js';
import type { BotConfig, BotInstance } from './types.js';
import type { MCPManager } from '@connectome/grpc-common';

/**
 * Create a bot instance (without connecting)
 */
export function createBotInstance(
  botConfig: BotConfig,
  grpcHost: string,
  grpcPort: number,
  mcpManager?: MCPManager
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

  // Resolve pi-ai model and create ConnectomeAgent
  const modelName = botConfig.model || 'claude-sonnet-4-20250514';
  const model = resolveModel(modelName);

  if (model) {
    const systemPrompt = botConfig.prompt || 'Standard';

    // Collect ToolHandler[] from fetch tool + MCP
    const toolHandlers: ToolHandler[] = [];
    if (botConfig.tools?.includes('fetch')) {
      toolHandlers.push(createFetchTool());
      console.log(`  🔧 ${botConfig.name}: fetch tool enabled`);
    }

    if (mcpManager && botConfig.mcp && botConfig.mcp.length > 0) {
      const mcpTools = mcpManager.getToolHandlersForServers(botConfig.mcp);
      toolHandlers.push(...mcpTools);
      console.log(`  🔌 ${botConfig.name}: ${mcpTools.length} MCP tool(s) from [${botConfig.mcp.join(', ')}]`);
    }

    botInstance.agent = new ConnectomeAgent({
      name: botConfig.name,
      systemPrompt,
      model,
      toolHandlers,
      promptCaching: botConfig.prompt_caching,
    });
    console.log(`  Created ConnectomeAgent for ${botConfig.name} (${modelName})`);
  } else {
    console.warn(`  No model found for ${botConfig.name} (${modelName}) - agent responses disabled`);
  }

  return botInstance;
}
