#!/usr/bin/env node
/**
 * Signal AXON gRPC Client Entry Point (Multi-Bot)
 * Connects multiple Signal bots to the Connectome gRPC server
 *
 * Architecture:
 * - Phones arrive via BOT_PHONE_NUMBERS env var (startup batch) and/or
 *   AxonBindingServer advertisements from bot-runtimes (dynamic)
 * - Names from SIGNAL_BOT_NAMES env var or signal-cli API
 * - UUIDs from signal-cli accounts.json
 * - Creates one gRPC client + WebSocket per bot
 * - Uses class-based components following Connectome nomenclature
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import { initErrorTracking, Sentry } from '@connectome/grpc-common';
initErrorTracking({ serviceName: 'signal-axon' });

import { AxonBindingServer } from '@connectome/axon-binding';
import type { AxonBinding } from '@connectome/axon-binding';

import {
  // Configuration
  getPhones,
  getGrpcConfig,
  getSignalCliConfig,
  getOperationalConfig,
  discoverBotUuid,
  discoverBotUuids,
  discoverBotNames,
  // Bot instance
  createBotInstance,
  // Components
  SignalWebSocketReceptor,
  SignalMessageReceptor,
  SignalReceiptReceptor,
  SignalTypingReceptor,
  FocusedContextTransform,
  SignalSpeechEffector,
  SignalCommandEffector,
  SignalSubstreamRelayEffector,
  MessageConsistencyChecker,
  // Utilities
  getNameToUuidCache,
  getNameToPhoneCache,
  // Types
  type SharedState,
  type RuntimeConfig,
  type BotInstance,
  type BotConfig,
  type SignalMessageEvent
} from './grpc/index.js';
import { messageDeduplicator } from './message-deduplicator.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     SIGNAL AXON - gRPC Client Mode (Multi-Bot)         ║');
  console.log('║     Signal messenger adapter for Connectome            ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log();

  // Load configuration from environment
  const phones = getPhones();
  const operationalConfig = getOperationalConfig();
  const { host, port } = getGrpcConfig();
  const { wsUrl, apiUrl } = getSignalCliConfig();
  const bindingPort = parseInt(process.env.AXON_BINDING_PORT || '0');

  console.log('Configuration:');
  console.log(`  Connectome gRPC:    ${host}:${port}`);
  console.log(`  Signal CLI WS:      ${wsUrl}`);
  console.log(`  Signal CLI API:     ${apiUrl}`);
  console.log(`  Phones (env):       ${phones.length}`);
  console.log(`  Axon binding:   ${bindingPort || 'disabled'}`);
  console.log();

  // Shared caches
  const nameToUuidCache = getNameToUuidCache();
  const nameToPhoneCache = getNameToPhoneCache();

  // Build managed bot name set (for speech routing)
  const managedBotNames = new Set<string>();

  // Phone/UUID/name mappings (mutable — grow as bots are added)
  const phoneToName = new Map<string, string>();
  const botUuidToName = new Map<string, string>();

  // Initialize shared state
  const state: SharedState = {
    bots: new Map<string, BotInstance>(),
    botUuidToName,
    uuidToName: new Map<string, string>(),
    botPhoneToName: phoneToName,
    processingActivations: new Set<string>(),
    botInteractionCounts: new Map<string, number>(),
    runtimeConfig: {
      randomReplyChance: operationalConfig.randomReplyChance,
      maxBotMentionsPerConversation: operationalConfig.maxBotMentionsPerConversation,
      maxConversationFrames: operationalConfig.maxConversationFrames,
      maxMemoryFrames: operationalConfig.maxMemoryFrames,
      groupPrivacyMode: operationalConfig.groupPrivacyMode
    }
  };

  // Store context transforms for runtime config updates
  const contextTransforms: FocusedContextTransform[] = [];

  // Substream relay: created once after the first bot connects
  let substreamRelay: SignalSubstreamRelayEffector | null = null;

  const updateRuntimeConfig = (updates: Partial<RuntimeConfig>) => {
    Object.assign(state.runtimeConfig, updates);
    console.log('[RuntimeConfig] Updated:', updates);
    if (updates.maxConversationFrames !== undefined) {
      for (const ct of contextTransforms) {
        ct.setMaxConversationFrames(updates.maxConversationFrames);
      }
    }
  };

  // Consistency checker + WS/message handler maps
  const allBotPhones: string[] = [];
  const wsHandlersMap = new Map<string, SignalWebSocketReceptor>();
  const messageHandlersMap = new Map<string, (event: SignalMessageEvent) => Promise<void>>();

  const consistencyChecker = new MessageConsistencyChecker({
    botUuidToName,
    botPhoneToName: phoneToName,
    allBotPhones,
    wsHandlers: wsHandlersMap,
    messageHandlers: messageHandlersMap,
    checkDelayMs: 2000
  });

  // ========================================================================
  // addSignalBot — reusable: initialize a single Signal bot
  // Called both at startup (env phones) and dynamically (binding ads)
  // ========================================================================
  async function addSignalBot(
    name: string, phone: string, uuid: string | undefined, source: string, agentName?: string
  ): Promise<boolean> {
    if (state.bots.has(phone)) {
      console.log(`  ${name}: Already managed, skipping (${source})`);
      return true;
    }

    console.log(`  Initializing ${name} (${phone}) [${source}]...`);

    // If UUID not provided, discover it via signal-cli REST API
    if (!uuid) {
      const found = await discoverBotUuid(phone, apiUrl);
      if (found) {
        uuid = found;
        console.log(`  ${name}: UUID discovered from signal-cli API: ${uuid}`);
      }
    }

    // Update caches
    phoneToName.set(phone, name);
    managedBotNames.add(name);
    allBotPhones.push(phone);
    nameToPhoneCache.set(name.toLowerCase(), phone);
    if (uuid) {
      botUuidToName.set(uuid, name);
      state.uuidToName.set(uuid, name);
      nameToUuidCache.set(name.toLowerCase(), uuid);
    }

    const botConfig: BotConfig = { name, phone, uuid, agentName };
    const bot = createBotInstance(botConfig, host, port);
    state.bots.set(phone, bot);

    // Create components
    const speechEffector = new SignalSpeechEffector({
      botConfig: bot.config,
      streamManager: bot.streamManager,
      managedBotNames,
      maxMessageLength: operationalConfig.maxMessageLength
    });
    speechEffector.setup();

    const contextTransform = new FocusedContextTransform({
      grpcClient: bot.grpcClient,
      botName: name,
      systemPrompt: 'Standard',
      maxConversationFrames: state.runtimeConfig.maxConversationFrames,
    });
    contextTransforms.push(contextTransform);

    const commandEffector = new SignalCommandEffector(name);

    const messageReceptor = new SignalMessageReceptor({
      bot, state, commandEffector, updateConfig: updateRuntimeConfig
    });

    const receiptReceptor = new SignalReceiptReceptor({ bot });
    const typingReceptor = new SignalTypingReceptor({ bot });

    const phoneToUuidLocal = new Map<string, string>();
    for (const [p, n] of phoneToName) {
      const u = [...botUuidToName.entries()].find(([, nn]) => nn === n)?.[0];
      if (u) phoneToUuidLocal.set(p, u);
    }

    const wsReceptor = new SignalWebSocketReceptor({
      wsUrl,
      httpUrl: apiUrl,
      botPhone: phone,
      botUuid: uuid,
      botUuids: phoneToUuidLocal,
      onMessage: async (event) => {
        consistencyChecker.recordMessage(event, phone);
        await messageReceptor.handleMessage(event);
      },
      onReceipt: async (_receipt) => {},
      onTyping: async (typing) => {
        await typingReceptor.handleTyping(typing);
      },
      onEdit: async (event) => {
        // Deduplicate in groups — only one bot should emit the edit
        const isGroup = !!event.groupId;
        const dedupeKey = `edit-${event.senderUuid || event.sender}-${event.originalTimestamp}`;
        if (isGroup && !messageDeduplicator.shouldEmit(dedupeKey, phone, true)) {
          return;
        }
        try {
          await bot.grpcClient.emitSignalMessageUpdate({
            content: event.content,
            sender: event.sender,
            senderNumber: event.senderNumber,
            senderUuid: event.senderUuid,
            groupId: event.groupId,
            groupName: event.groupName,
            botPhone: phone,
            originalTimestamp: event.originalTimestamp,
            editedTimestamp: event.editedTimestamp
          });
          console.log(`[SignalAxon:${name}] Emitted messageUpdate for ts=${event.originalTimestamp}: ${event.content.substring(0, 50)}...`);
        } catch (error: any) {
          console.error(`[SignalAxon:${name}] Error emitting messageUpdate:`, error.message);
        }
      },
      onDelete: async (event) => {
        // Deduplicate in groups
        const isGroup = !!event.groupId;
        const dedupeKey = `delete-${event.senderUuid || event.senderNumber}-${event.targetTimestamp}`;
        if (isGroup && !messageDeduplicator.shouldEmit(dedupeKey, phone, true)) {
          return;
        }
        try {
          await bot.grpcClient.emitSignalMessageDelete({
            senderUuid: event.senderUuid,
            senderNumber: event.senderNumber,
            groupId: event.groupId,
            botPhone: phone,
            targetTimestamp: event.targetTimestamp
          });
          console.log(`[SignalAxon:${name}] Emitted messageDelete for ts=${event.targetTimestamp}`);
        } catch (error: any) {
          console.error(`[SignalAxon:${name}] Error emitting messageDelete:`, error.message);
        }
      }
    });

    wsHandlersMap.set(phone, wsReceptor);
    messageHandlersMap.set(phone, (event) => messageReceptor.handleMessage(event));

    // Connect gRPC and start WebSocket
    try {
      await bot.grpcClient.connect();
      wsReceptor.connect();

      // Start substream relay after the first bot connects (singleton)
      if (!substreamRelay) {
        substreamRelay = new SignalSubstreamRelayEffector({ state });
        substreamRelay.setup();
        console.log(`  [SignalSubstreamRelay] Started (using ${name}'s gRPC connection)`);
      }

      console.log(`  ${name}: Components initialized, connected [${source}]`);
      return true;
    } catch (error: any) {
      console.error(`  ${name}: Failed to connect: ${error.message}`);
      // Clean up tracking maps so consistency checker doesn't try to use this bot
      state.bots.delete(phone);
      phoneToName.delete(phone);
      managedBotNames.delete(name);
      wsHandlersMap.delete(phone);
      messageHandlersMap.delete(phone);
      const idx = allBotPhones.indexOf(phone);
      if (idx >= 0) allBotPhones.splice(idx, 1);
      if (uuid) {
        botUuidToName.delete(uuid);
        nameToUuidCache.delete(name.toLowerCase());
      }
      nameToPhoneCache.delete(name.toLowerCase());
      return false;
    }
  }

  // ========================================================================
  // Step 1: Start AxonBindingServer FIRST (so bot-runtimes can connect
  // while env-based bots are still initializing)
  // ========================================================================
  let bindingServer: AxonBindingServer | undefined;

  if (bindingPort > 0) {
    bindingServer = new AxonBindingServer({ port: bindingPort });

    // Queue binding advertisements so signal-cli UUID discovery calls are serialized
    // (signal-cli can't handle 15+ concurrent /v1/identities requests)
    const bindingQueue: AxonBinding[] = [];
    let processingBindings = false;

    async function processBindingQueue(): Promise<void> {
      if (processingBindings) return;
      processingBindings = true;
      while (bindingQueue.length > 0) {
        const binding = bindingQueue.shift()!;
        const phone = binding.credentials.phone;
        if (!phone) {
          console.error(`[AxonBinding] Signal binding for ${binding.agentName} missing phone`);
          continue;
        }
        console.log(`[AxonBinding] Adding bot ${binding.agentName}...`);
        await addSignalBot(
          binding.agentName,
          phone,
          binding.credentials.uuid,
          `binding:${binding.agentName}`,
          binding.agentName  // pass as agentName
        );
      }
      processingBindings = false;
    }

    bindingServer.on('binding:added', (binding: AxonBinding) => {
      if (binding.platform !== 'signal') {
        console.log(`[AxonBinding] Ignoring non-signal binding: ${binding.agentName} → ${binding.platform}`);
        return;
      }
      bindingQueue.push(binding);
      processBindingQueue();
    });

    await bindingServer.start();
  }

  // ========================================================================
  // Step 2: Initialize bots from env vars (startup batch)
  // ========================================================================
  if (phones.length > 0) {
    console.log('Discovering bot names...');
    const envPhoneToName = await discoverBotNames(phones, apiUrl);
    console.log('Discovering bot UUIDs...');
    const phoneToUuid = await discoverBotUuids(phones, apiUrl);

    console.log(`\nInitializing ${phones.length} bot(s) from env...`);

    for (const phone of phones) {
      const name = envPhoneToName.get(phone);
      if (!name) {
        console.warn(`  No name for ${phone}, skipping`);
        continue;
      }
      const uuid = phoneToUuid.get(phone);
      await addSignalBot(name, phone, uuid, 'env');
    }

    console.log(`  ${state.bots.size} bot(s) initialized from env`);
    console.log();
  }

  if (state.bots.size === 0 && !bindingServer) {
    console.error('Error: No bots initialized and no binding server running');
    process.exit(1);
  }

  // Handle shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\n\nShutting down...');

    if (bindingServer) {
      await bindingServer.stop();
    }

    consistencyChecker.stop();

    if (substreamRelay) {
      substreamRelay.destroy();
    }

    for (const [, ws] of wsHandlersMap) {
      ws.disconnect();
    }

    for (const [botPhone, bot] of state.bots) {
      const botName = phoneToName.get(botPhone);
      console.log(`  Disconnecting ${botName}...`);
      bot.streamManager.unsubscribeAll();
      bot.grpcClient.disconnect();
    }

    await Sentry.flush(2000);
    console.log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Signal AXON running with ${state.bots.size} bot(s)`);
  if (bindingServer) {
    console.log(`  Axon binding server on port ${bindingPort}`);
  }
  console.log('  Listening for Signal messages...');
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nPress Ctrl+C to stop.\n');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
