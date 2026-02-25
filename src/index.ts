/**
 * Signal AXON Module for Connectome
 *
 * Exports gRPC components for Signal messenger integration.
 * All bots are remote: signal-axon is purely a gateway.
 */

// Re-export everything from gRPC module
export * from './grpc/index.js';

// Also export message deduplicator (shared utility)
export { messageDeduplicator } from './message-deduplicator.js';
