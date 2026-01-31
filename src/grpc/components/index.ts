/**
 * gRPC Components - Client-side equivalents of Connectome Components
 *
 * These classes maintain the Connectome nomenclature (Receptor, Transform, Effector)
 * while operating as gRPC clients rather than server-side Components.
 *
 * Architecture mapping:
 * - Receptors: Handle Signal events, emit to Connectome server
 * - Transforms: Fetch/render context from server
 * - Effectors: Run agents, send responses to Signal
 */

// Receptors - Handle Signal events
export { SignalWebSocketReceptor } from './signal-websocket-receptor.js';
export type { SignalWebSocketReceptorConfig, SignalReceiptEvent, SignalTypingEvent } from './signal-websocket-receptor.js';

export { SignalMessageReceptor } from './signal-message-receptor.js';
export type { SignalMessageReceptorConfig } from './signal-message-receptor.js';

export { SignalReceiptReceptor } from './signal-receipt-receptor.js';
export type { SignalReceiptReceptorConfig } from './signal-receipt-receptor.js';

export { SignalTypingReceptor } from './signal-typing-receptor.js';
export type { SignalTypingReceptorConfig } from './signal-typing-receptor.js';

// Transforms - Fetch and render context
export { FocusedContextTransform } from './focused-context-transform.js';
export type { FocusedContextTransformConfig, RenderedContext, ContextMessage } from './focused-context-transform.js';

// Effectors - Run agents and send responses
export { SignalAgentEffector } from './signal-agent-effector.js';
export type { SignalAgentEffectorConfig, AgentActivation } from './signal-agent-effector.js';

export { SignalSpeechEffector } from './signal-speech-effector.js';
export type { SignalSpeechEffectorConfig } from './signal-speech-effector.js';

export { SignalCommandEffector } from './signal-command-effector.js';
export type { ConfigUpdateCallback } from './signal-command-effector.js';

// Consistency checking
export { MessageConsistencyChecker } from './message-consistency-checker.js';
export type { MessageConsistencyConfig } from './message-consistency-checker.js';
