#!/usr/bin/env node
/**
 * Signal AXON gRPC Client Entry Point (Multi-Bot)
 * Connects multiple Signal bots to the Connectome gRPC server
 *
 * Architecture:
 * - Loads config.json for bot configurations
 * - Parses BOT_PHONE_NUMBERS (comma-separated) and pairs by index with bots
 * - Creates one gRPC client per bot
 * - Creates one WebSocket connection per bot (to Signal CLI)
 * - Uses class-based components following Connectome nomenclature
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import {
  // Configuration
  loadConfig,
  pairPhonesWithBots,
  getGrpcConfig,
  getSignalCliConfig,
  loadBotUuids,
  // Bot instance
  createBotInstance,
  // Components
  SignalWebSocketReceptor,
  SignalMessageReceptor,
  SignalReceiptReceptor,
  SignalTypingReceptor,
  FocusedContextTransform,
  SignalAgentEffector,
  SignalSpeechEffector,
  SignalCommandEffector,
  MessageConsistencyChecker,
  // Utilities
  getNameToUuidCache,
  getNameToPhoneCache,
  // Types
  type SharedState,
  type RuntimeConfig,
  type BotInstance,
  type SignalMessageEvent
} from './grpc/index.js';
import { MCPManager } from '@connectome/grpc-common';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     SIGNAL AXON - gRPC Client Mode (Multi-Bot)         ║');
  console.log('║     Signal messenger adapter for Connectome            ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log();

  // Load configuration
  const config = loadConfig();
  const { host, port } = getGrpcConfig();
  const { wsUrl, apiUrl } = getSignalCliConfig();

  console.log('Configuration:');
  console.log(`  Connectome gRPC: ${host}:${port}`);
  console.log(`  Signal CLI WS:   ${wsUrl}`);
  console.log(`  Signal CLI API:  ${apiUrl}`);
  console.log();

  // Pair phone numbers with bot configs
  console.log('Pairing bots with phone numbers...');
  const pairedBots = pairPhonesWithBots(config);

  if (pairedBots.length === 0) {
    console.error('Error: No bots configured with phone numbers');
    process.exit(1);
  }

  console.log();

  // Initialize MCP servers (global pool)
  const mcpManager = new MCPManager();
  const mcpServers = (config as any).mcp_servers || [];

  if (mcpServers.length > 0) {
    console.log(`Connecting to ${mcpServers.length} MCP server(s)...`);
    await mcpManager.connectAll(mcpServers);
    const connectedServers = mcpManager.getConnectedServers();
    console.log(`  Connected: ${connectedServers.join(', ') || '(none)'}`);
    const allTools = mcpManager.getAllToolHandlers();
    console.log(`  Total MCP tools available: ${allTools.length}`);
    console.log();
  }

  console.log(`Initializing ${pairedBots.length} bot(s)...`);
  console.log();

  // Build phone → name and name → phone mappings
  const botPhoneToName = new Map<string, string>();
  const botNameToPhone = new Map<string, string>();
  for (const botConfig of pairedBots) {
    botPhoneToName.set(botConfig.phone!, botConfig.name);
    botNameToPhone.set(botConfig.name, botConfig.phone!);
  }

  // Load bot UUIDs from Signal CLI accounts
  console.log('Loading bot UUIDs...');
  const botPhoneToUuid = loadBotUuids(
    pairedBots.map(b => b.phone!),
    botPhoneToName
  );

  // Build UUID → name mapping
  const botUuidToName = new Map<string, string>();
  for (const [phone, uuid] of botPhoneToUuid) {
    const name = botPhoneToName.get(phone);
    if (name && uuid) {
      botUuidToName.set(uuid, name);
    }
  }

  // Populate the name → UUID cache for incoming mention resolution
  const nameToUuidCache = getNameToUuidCache();
  for (const [uuid, name] of botUuidToName) {
    nameToUuidCache.set(name.toLowerCase(), uuid);
  }
  console.log(`  Populated name→UUID cache with ${nameToUuidCache.size} bot(s)`);

  // Populate the name → phone cache for outgoing mention creation
  // Signal CLI API requires phone numbers, not UUIDs
  const nameToPhoneCache = getNameToPhoneCache();
  for (const [phone, name] of botPhoneToName) {
    nameToPhoneCache.set(name.toLowerCase(), phone);
  }
  console.log(`  Populated name→phone cache with ${nameToPhoneCache.size} bot(s)`);
  console.log();

  // Initialize shared state
  const state: SharedState = {
    bots: new Map<string, BotInstance>(),
    botUuidToName,
    botPhoneToName,
    processingActivations: new Set<string>(),
    botInteractionCounts: new Map<string, number>(),
    runtimeConfig: {
      randomReplyChance: config.random_reply_chance || 0,
      maxBotMentionsPerConversation: config.max_bot_mentions_per_conversation || 3,
      maxConversationFrames: config.max_conversation_frames || 100,
      maxMemoryFrames: 500,
      groupPrivacyMode: config.group_privacy_mode || 'opt-out'
    },
    pairedBots
  };

  // Store context transforms for runtime config updates
  const contextTransforms: FocusedContextTransform[] = [];

  const updateRuntimeConfig = (updates: Partial<RuntimeConfig>) => {
    Object.assign(state.runtimeConfig, updates);
    console.log('[RuntimeConfig] Updated:', updates);

    // Propagate maxConversationFrames to all context transforms
    if (updates.maxConversationFrames !== undefined) {
      for (const ct of contextTransforms) {
        ct.setMaxConversationFrames(updates.maxConversationFrames);
      }
    }
  };

  // Initialize each bot
  const allBotNames = pairedBots.map(b => b.name);
  const allBotPhones = pairedBots.map(b => b.phone!);
  const wsHandlersMap = new Map<string, SignalWebSocketReceptor>();
  const messageHandlersMap = new Map<string, (event: SignalMessageEvent) => Promise<void>>();

  // Create consistency checker (will be fully configured after bots are initialized)
  const consistencyChecker = new MessageConsistencyChecker({
    botUuidToName,
    botPhoneToName,
    allBotPhones,
    wsHandlers: wsHandlersMap,
    messageHandlers: messageHandlersMap,
    checkDelayMs: 2000  // Wait 2 seconds for all bots to receive
  });

  for (const botConfig of pairedBots) {
    const botPhone = botConfig.phone!;
    console.log(`Initializing ${botConfig.name} (${botPhone})...`);

    // Create bot instance (with MCP manager for tool access)
    const bot = createBotInstance(botConfig, host, port, mcpManager);
    state.bots.set(botPhone, bot);

    // Create components following Connectome nomenclature

    // 1. SignalSpeechEffector - handles server-initiated speech
    const speechEffector = new SignalSpeechEffector({
      botConfig: bot.config,
      streamManager: bot.streamManager,
      allBotNames,
      maxMessageLength: config.max_message_length
    });
    speechEffector.setup();

    // 2. FocusedContextTransform - fetches and renders context from server
    const contextTransform = new FocusedContextTransform({
      grpcClient: bot.grpcClient,
      botName: botConfig.name,
      systemPrompt: botConfig.prompt || 'Standard',
      maxConversationFrames: state.runtimeConfig.maxConversationFrames,
      skipIdentityPrompt: botConfig.skip_identity_prompt,
    });
    contextTransforms.push(contextTransform);

    // 3. SignalCommandEffector - handles ! commands
    const commandEffector = new SignalCommandEffector(botConfig.name);

    // 4. SignalAgentEffector - runs agent and sends responses
    let agentEffector: SignalAgentEffector | undefined;
    if (bot.agent) {
      agentEffector = new SignalAgentEffector({
        agent: bot.agent,
        botConfig: bot.config,
        grpcClient: bot.grpcClient,
        contextTransform,
        botUuidToName: state.botUuidToName,
        maxMessageLength: config.max_message_length
      });
    }

    // 5. SignalMessageReceptor - handles Signal messages
    let messageReceptor: SignalMessageReceptor | undefined;
    if (agentEffector) {
      messageReceptor = new SignalMessageReceptor({
        bot,
        state,
        agentEffector,
        commandEffector,
        updateConfig: updateRuntimeConfig
      });
    } else {
      console.warn(`  ${botConfig.name}: No agent configured, message handling disabled`);
    }

    // 6. SignalReceiptReceptor - handles receipts
    const receiptReceptor = new SignalReceiptReceptor({ bot });

    // 7. SignalTypingReceptor - handles typing indicators
    const typingReceptor = new SignalTypingReceptor({ bot });

    // 8. SignalWebSocketReceptor - handles WebSocket connection to Signal CLI
    const wsReceptor = new SignalWebSocketReceptor({
      wsUrl,
      httpUrl: apiUrl,  // HTTP base URL for downloading attachments
      botPhone,
      botUuid: botPhoneToUuid.get(botPhone),  // This bot's UUID for mention detection
      botUuids: botPhoneToUuid,
      onMessage: async (event) => {
        // Record for consistency checking BEFORE any filtering
        // This allows the checker to track which bots received each message
        consistencyChecker.recordMessage(event, botPhone);

        if (messageReceptor) {
          await messageReceptor.handleMessage(event);
        }
      },
      // NOTE: Do not delete - receipt handling disabled to avoid flooding connectome server
      // onReceipt: async (receipt) => {
      //   await receiptReceptor.handleReceipt(receipt);
      // },
      onReceipt: async (_receipt) => {},
      onTyping: async (typing) => {
        await typingReceptor.handleTyping(typing);
      }
    });

    // Store for consistency checker and shutdown
    wsHandlersMap.set(botPhone, wsReceptor);
    if (messageReceptor) {
      messageHandlersMap.set(botPhone, (event) => messageReceptor.handleMessage(event));
    }

    console.log(`  ${botConfig.name}: Components initialized`);
  }

  // Handle shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\n\nShutting down...');

    // Disconnect MCP servers
    if (mcpManager.getConnectedServers().length > 0) {
      console.log('  Disconnecting MCP servers...');
      await mcpManager.disconnectAll();
    }

    // Stop consistency checker
    consistencyChecker.stop();

    // Disconnect WebSocket handlers
    for (const [, ws] of wsHandlersMap) {
      ws.disconnect();
    }

    for (const [botPhone, bot] of state.bots) {
      const botName = botPhoneToName.get(botPhone);
      console.log(`  Disconnecting ${botName}...`);
      bot.streamManager.unsubscribeAll();
      bot.grpcClient.disconnect();
    }

    console.log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Connect all bots
  console.log('\nConnecting to services...');

  for (const [botPhone, bot] of state.bots) {
    const botName = botPhoneToName.get(botPhone)!;

    try {
      // Connect to Connectome gRPC server
      await bot.grpcClient.connect();
      console.log(`  ${botName}: Connected to Connectome`);
    } catch (error: any) {
      console.error(`  ${botName}: Failed to connect to Connectome: ${error.message}`);
    }
  }

  // Start WebSocket connections
  for (const [, ws] of wsHandlersMap) {
    ws.connect();
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Signal AXON running with ${state.bots.size} bot(s)`);
  console.log('  Listening for Signal messages...');
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nPress Ctrl+C to stop.\n');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
