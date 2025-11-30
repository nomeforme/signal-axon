/**
 * Signal AXON Module for Connectome
 *
 * Exports RETM components for Signal messenger integration
 */

import { SignalAfferent, SignalAfferentConfig } from './signal-afferent';
import { SignalMessageReceptor, SignalReceiptReceptor, SignalTypingReceptor, SignalReceptorConfig } from './signal-receptor';
import { SignalSpeechEffector, SignalCommandEffector, SignalEffectorConfig, ConfigUpdateCallback } from './signal-effector';
import { MessageConsistencyReceptor, MessageConsistencyConfig } from './message-consistency-receptor';
import { messageDeduplicator } from './message-deduplicator';

// Re-export types and classes
export {
  SignalAfferent,
  SignalAfferentConfig,
  SignalMessageReceptor,
  SignalReceiptReceptor,
  SignalTypingReceptor,
  SignalReceptorConfig,
  SignalSpeechEffector,
  SignalCommandEffector,
  SignalEffectorConfig,
  ConfigUpdateCallback,
  MessageConsistencyReceptor,
  MessageConsistencyConfig,
  messageDeduplicator
};

/**
 * Factory function to create Signal components for a bot
 *
 * This is a convenience helper for applications that want to quickly
 * set up Signal integration.
 */
export function createSignalComponents(config: {
  botPhone: string;
  wsUrl: string;
  apiUrl: string;
  botUuids: Map<string, string>;
  botNames: Map<string, string>;
}) {
  const afferent = new SignalAfferent();

  const receptorConfig: SignalReceptorConfig = {
    botUuids: config.botUuids,
    botNames: config.botNames
  };

  const messageReceptor = new SignalMessageReceptor(receptorConfig);
  const receiptReceptor = new SignalReceiptReceptor();
  const typingReceptor = new SignalTypingReceptor();

  const effectorConfig: SignalEffectorConfig = {
    apiUrl: config.apiUrl,
    botNames: config.botNames
  };

  const speechEffector = new SignalSpeechEffector(effectorConfig);

  return {
    afferent,
    afferentConfig: {
      botPhone: config.botPhone,
      wsUrl: config.wsUrl
    },
    receptors: {
      message: messageReceptor,
      receipt: receiptReceptor,
      typing: typingReceptor
    },
    effectors: {
      speech: speechEffector
    }
  };
}
