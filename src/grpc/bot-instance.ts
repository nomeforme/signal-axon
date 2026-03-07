/**
 * Bot instance management for Signal AXON gRPC mode
 * Handles creation and setup of individual bot instances
 *
 * All bots are remote: cognition is delegated to standalone bot-runtime containers.
 * Signal-axon is purely a gateway.
 */

import { SignalGrpcClient } from './client.js';
import { StreamManager } from './stream-manager.js';
import type { BotConfig, BotInstance } from './types.js';

/**
 * Create a bot instance from discovered identity
 *
 * Name is discovered from signal-cli or SIGNAL_BOT_NAMES env, not from static config.
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

  const botInstance: BotInstance = {
    config: botConfig,
    grpcClient,
    streamManager
  };

  // Remote bots delegate cognition to external bot-runtime
  console.log(`  ${botConfig.name}: Remote mode — cognition delegated to bot-runtime`);

  return botInstance;
}
