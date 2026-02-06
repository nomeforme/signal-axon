/**
 * SignalAgentEffector - gRPC equivalent of the non-gRPC agent effector
 *
 * Processes agent activations with native tool support:
 * 1. Receives activation trigger from SignalMessageReceptor
 * 2. Fetches context via FocusedContextTransform
 * 3. Runs ToolLoopAgent cycle
 * 4. Sends response to Signal
 * 5. Records speech in Connectome server state
 *
 * This is the gRPC client-side equivalent - it runs the agent locally
 * and communicates results back to the server.
 */

import axios from 'axios';
import { cleanSpeechContent, splitMessage, detectAndConvertMentions, getNameToPhoneCache, convertGroupId } from '../utils/index.js';
import { getSignalCliConfig } from '../config-loader.js';
import type { SignalGrpcClient } from '../client.js';
import type { ToolLoopAgent } from '../../tool-loop-agent.js';
import type { BotConfig, SignalMessageEvent } from '../types.js';
import type { FocusedContextTransform } from './focused-context-transform.js';

export interface SignalAgentEffectorConfig {
  agent: ToolLoopAgent;
  botConfig: BotConfig;
  grpcClient: SignalGrpcClient;
  contextTransform: FocusedContextTransform;
  botUuidToName: Map<string, string>;
  maxMessageLength?: number;
}

export interface AgentActivation {
  streamId: string;
  event: SignalMessageEvent;
  readableContent: string;
  activationReason: string;
}

/**
 * SignalAgentEffector - Runs agent cycles and sends responses
 *
 * Constraint equivalent: EFFECTOR priority (runs after transforms to produce side effects)
 */
export class SignalAgentEffector {
  private agent: ToolLoopAgent;
  private botConfig: BotConfig;
  private grpcClient: SignalGrpcClient;
  private contextTransform: FocusedContextTransform;
  private botUuidToName: Map<string, string>;
  private maxMessageLength?: number;
  private processingActivations = new Set<string>();

  constructor(config: SignalAgentEffectorConfig) {
    this.agent = config.agent;
    this.botConfig = config.botConfig;
    this.grpcClient = config.grpcClient;
    this.contextTransform = config.contextTransform;
    this.botUuidToName = config.botUuidToName;
    this.maxMessageLength = config.maxMessageLength;
  }

  /**
   * Get bot name
   */
  getName(): string {
    return this.botConfig.name;
  }

  /**
   * Run agent cycle for an activation
   */
  async runAgentCycle(activation: AgentActivation): Promise<boolean> {
    const { streamId, event, readableContent, activationReason } = activation;
    const botName = this.botConfig.name;
    const activationId = `${streamId}-${Date.now()}`;

    // Skip if already processing this stream
    if (this.processingActivations.has(streamId)) {
      console.log(`[SignalAgentEffector:${botName}] Already processing activation for stream ${streamId}, skipping`);
      return false;
    }

    this.processingActivations.add(activationId);
    console.log(`[SignalAgentEffector:${botName}] Running agent cycle (reason: ${activationReason})...`);

    try {
      // Fetch and render context via FocusedContextTransform
      // Pass current message to ensure it's included even if server hasn't persisted it yet
      let renderedContext;
      try {
        renderedContext = await this.contextTransform.renderContext(streamId, {
          currentMessage: {
            content: readableContent,
            senderName: event.sender
          }
        });
      } catch (contextError: any) {
        console.warn(`[SignalAgentEffector:${botName}] Context fetch failed, using fallback:`, contextError.message);
        renderedContext = this.contextTransform.buildFallbackContext(readableContent, event.sender);
      }

      // Build stream reference
      const streamRef = { streamId, streamType: 'signal' };

      // Run the tool-loop agent cycle
      const result = await this.agent.runCycle(renderedContext as any, streamRef);

      console.log(`[SignalAgentEffector:${botName}] Agent cycle completed with ${result.operations.length} operations, content length: ${result.content.length}`);

      // Send response to Signal
      if (result.content) {
        await this.sendSpeechToSignal(result.content, event, streamId);
      }

      return true;
    } catch (error: any) {
      console.error(`[SignalAgentEffector:${botName}] Agent cycle error:`, error.message);
      console.error(error.stack);

      // Emit error message
      await this.emitErrorSpeech(error.message, event, streamId);

      return false;
    } finally {
      this.processingActivations.delete(activationId);
    }
  }

  /**
   * Send speech to Signal
   */
  private async sendSpeechToSignal(
    content: string,
    originalEvent: SignalMessageEvent,
    streamId: string
  ): Promise<void> {
    const botName = this.botConfig.name;
    const botPhone = this.botConfig.phone!;

    // Clean speech content (strip XML tags, etc.)
    let cleanedContent = cleanSpeechContent(content);
    if (!cleanedContent) return;

    try {
      const { apiUrl } = getSignalCliConfig();

      // Detect @mentions and convert to Signal format (uses phone numbers for Signal CLI API)
      const { content: contentWithMentions, mentions } = detectAndConvertMentions(
        cleanedContent,
        getNameToPhoneCache()
      );

      // Split and send
      const chunks = splitMessage(contentWithMentions, this.maxMessageLength);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const body: any = {
          number: botPhone,
          message: chunk,
          text_mode: 'styled'  // Enable Signal text formatting (*bold*, _italic_, etc.)
        };

        // Only include mentions in the first chunk
        if (i === 0 && mentions.length > 0) {
          body.mentions = mentions;
        }

        if (originalEvent.groupId) {
          // Convert internal group ID to external group ID for Signal CLI API
          const externalGroupId = await convertGroupId(originalEvent.groupId, botPhone);
          body.recipients = [externalGroupId || originalEvent.groupId];
        } else {
          body.recipients = [originalEvent.senderNumber || originalEvent.senderUuid];
        }

        await axios.post(`${apiUrl}/v2/send`, body, {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log(`[SignalAgentEffector:${botName}] Sent response (${chunks.length} chunk(s))`);

      // Record speech in server state
      await this.recordSpeechOnServer(cleanedContent, streamId);
    } catch (error: any) {
      console.error(`[SignalAgentEffector:${botName}] Error sending to Signal:`, error.message);
    }
  }

  /**
   * Record speech in Connectome server state
   */
  private async recordSpeechOnServer(
    content: string,
    streamId: string
  ): Promise<void> {
    const botName = this.botConfig.name;

    try {
      // The emitEvent is a generic event emission - we emit agent:speech
      await this.grpcClient.emitEvent(
        'agent:speech',
        {
          content,
          agentId: botName,
          agentName: botName,
          streamId,
          timestamp: Date.now()
        }
      );
      console.log(`[SignalAgentEffector:${botName}] Recorded speech in server state`);
    } catch (speechError: any) {
      console.warn(`[SignalAgentEffector:${botName}] Failed to record speech:`, speechError.message);
    }
  }

  /**
   * Emit error message to Signal
   */
  private async emitErrorSpeech(
    errorMessage: string,
    originalEvent: SignalMessageEvent,
    streamId: string
  ): Promise<void> {
    const botName = this.botConfig.name;
    const botPhone = this.botConfig.phone!;

    try {
      const { apiUrl } = getSignalCliConfig();

      const body: any = {
        number: botPhone,
        message: `Error: ${errorMessage}`,
        text_mode: 'styled'
      };

      if (originalEvent.groupId) {
        // Convert internal group ID to external group ID for Signal CLI API
        const externalGroupId = await convertGroupId(originalEvent.groupId, botPhone);
        body.recipients = [externalGroupId || originalEvent.groupId];
      } else {
        body.recipients = [originalEvent.senderNumber || originalEvent.senderUuid];
      }

      await axios.post(`${apiUrl}/v2/send`, body, {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      console.error(`[SignalAgentEffector:${botName}] Failed to send error message:`, error.message);
    }
  }
}
