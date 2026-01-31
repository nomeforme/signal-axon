/**
 * Signal AXON gRPC exports
 */

// Core clients
export { SignalGrpcClient, type SignalGrpcClientConfig } from './client.js';
export { StreamManager, type StreamInfo } from './stream-manager.js';

// Types
export * from './types.js';

// Configuration
export { loadConfig, pairPhonesWithBots, getGrpcConfig, getSignalCliConfig, loadBotUuids } from './config-loader.js';

// Bot instance management
export { createBotInstance } from './bot-instance.js';

// Components (class-based, Connectome nomenclature)
export * from './components/index.js';

// Utilities
export * from './utils/index.js';
