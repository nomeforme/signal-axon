/**
 * FocusedContextTransform - gRPC equivalent for Signal
 *
 * Fetches and renders per-agent context from the Connectome server:
 * 1. Fetches VEIL state via gRPC GetContext
 * 2. Transforms server facets into LLM-compatible messages
 * 3. Injects bot identity into system prompt
 * 4. Filters by stream (conversation) to avoid cross-context pollution
 *
 * This is the gRPC client-side equivalent - it fetches context from
 * the server rather than accessing VEILStateManager directly.
 */

import type { SignalGrpcClient } from '../client.js';

/**
 * Message format for LLM context
 */
export interface ContextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  metadata?: {
    attachments?: Array<{
      contentType?: string;
      data?: string;
    }>;
  };
}

/**
 * Rendered context for the agent
 */
export interface RenderedContext {
  messages: ContextMessage[];
  metadata: {
    totalTokens?: number;
    frameCount: number;
    streamId?: string;
  };
}

export interface FocusedContextTransformConfig {
  grpcClient: SignalGrpcClient;
  botName: string;
  systemPrompt: string;
  maxConversationFrames: number;
  maxTokens: number;
}

/**
 * FocusedContextTransform - Renders context for agent activation
 *
 * Constraint equivalent: priority 100 (runs after receptors to transform state)
 */
export class FocusedContextTransform {
  private grpcClient: SignalGrpcClient;
  private botName: string;
  private systemPrompt: string;
  private maxConversationFrames: number;
  private maxTokens: number;

  constructor(config: FocusedContextTransformConfig) {
    this.grpcClient = config.grpcClient;
    this.botName = config.botName;
    this.systemPrompt = config.systemPrompt;
    this.maxConversationFrames = config.maxConversationFrames;
    this.maxTokens = config.maxTokens;
  }

  /**
   * Update max conversation frames (for runtime config changes)
   */
  setMaxConversationFrames(value: number): void {
    this.maxConversationFrames = value;
    console.log(`[FocusedContextTransform:${this.botName}] maxConversationFrames set to ${value}`);
  }

  /**
   * Render context for the agent
   *
   * Fetches context from the server and transforms it into LLM messages.
   * If currentMessage is provided, it will be appended to ensure the triggering
   * message is included even if the server hasn't persisted it yet.
   */
  async renderContext(
    streamId: string,
    options?: {
      maxFrames?: number;
      maxTokens?: number;
      currentMessage?: {
        content: string;
        senderName: string;
      };
    }
  ): Promise<RenderedContext> {
    const maxFrames = options?.maxFrames ?? this.maxConversationFrames;
    const maxTokens = options?.maxTokens ?? this.maxTokens;

    console.log(`[FocusedContextTransform:${this.botName}] Fetching context for stream ${streamId} (maxFrames=${maxFrames})`);

    try {
      // Fetch context from server via gRPC
      const serverContext = await this.grpcClient.getContext(streamId, {
        maxFrames,
        maxTokens
      });

      console.log(`[FocusedContextTransform:${this.botName}] Received context from server`);

      // Transform server context to LLM messages
      const messages = this.transformToMessages(serverContext);

      // Ensure current message is included (server may not have persisted it yet)
      if (options?.currentMessage) {
        const currentContent = `<${options.currentMessage.senderName}> ${options.currentMessage.content}`;
        const hasCurrentMessage = messages.some(m =>
          m.role === 'user' && m.content.includes(options.currentMessage!.content)
        );

        if (!hasCurrentMessage) {
          console.log(`[FocusedContextTransform:${this.botName}] Adding current message to context`);
          messages.push({
            role: 'user',
            content: currentContent
          });
        }
      }

      // Log conversation data before sending to LLM
      this.logConversationData(messages, streamId);

      return {
        messages,
        metadata: {
          frameCount: serverContext?.metadata?.frameCount || 0,
          streamId
        }
      };
    } catch (error: any) {
      console.warn(`[FocusedContextTransform:${this.botName}] Context fetch failed:`, error.message);

      // Return fallback with current message if available
      if (options?.currentMessage) {
        return this.buildFallbackContext(options.currentMessage.content, options.currentMessage.senderName);
      }

      // Return minimal context on error
      return this.buildMinimalContext();
    }
  }

  /**
   * Transform server context to LLM messages
   */
  private transformToMessages(serverContext: any): ContextMessage[] {
    const messages: ContextMessage[] = [];

    // Build system prompt with bot identity
    const systemContent = this.buildSystemPrompt();
    messages.push({
      role: 'system',
      content: systemContent
    });

    // Transform conversation from server
    if (serverContext?.conversation && Array.isArray(serverContext.conversation)) {
      for (const msg of serverContext.conversation) {
        // Skip internal messages (thoughts)
        if (msg.internal) continue;

        const role = msg.role as 'system' | 'user' | 'assistant';

        // Skip system messages from server (we add our own)
        if (role === 'system') continue;

        if (role === 'user' || role === 'assistant') {
          const message: ContextMessage = {
            role,
            content: msg.content || ''
          };

          // Include attachments if present
          if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
            message.metadata = {
              attachments: msg.attachments
            };
          }

          messages.push(message);
        }
      }
    }

    return messages;
  }

  /**
   * Build system prompt with bot identity and Signal capabilities
   */
  private buildSystemPrompt(): string {
    const identityPrompt = `You are <${this.botName}> in Signal messenger.

To mention users, use @username syntax. The system will convert usernames to Signal mention format automatically.`;

    if (this.systemPrompt && this.systemPrompt !== 'Standard') {
      return `${this.systemPrompt}\n\n${identityPrompt}`;
    }

    return identityPrompt;
  }

  /**
   * Build minimal context when server is unavailable
   */
  private buildMinimalContext(): RenderedContext {
    return {
      messages: [
        {
          role: 'system',
          content: this.buildSystemPrompt()
        }
      ],
      metadata: {
        frameCount: 0
      }
    };
  }

  /**
   * Build fallback context with a single user message
   * Used when server context is not available
   */
  buildFallbackContext(messageContent: string, senderName: string): RenderedContext {
    return {
      messages: [
        {
          role: 'system',
          content: this.buildSystemPrompt()
        },
        {
          role: 'user',
          content: `<${senderName}> ${messageContent}`
        }
      ],
      metadata: {
        frameCount: 1
      }
    };
  }

  /**
   * Log conversation data before sending to LLM
   */
  private logConversationData(messages: ContextMessage[], streamId: string): void {
    console.log(`\n╔══════════════════════════════════════════════════════════════════════════════`);
    console.log(`║ [FocusedContextTransform:${this.botName}] CONVERSATION DATA FOR LLM`);
    console.log(`║ Stream: ${streamId}`);
    console.log(`║ Total messages: ${messages.length}`);
    console.log(`╠══════════════════════════════════════════════════════════════════════════════`);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const roleLabel = msg.role.toUpperCase().padEnd(9);
      const contentPreview = msg.content.length > 200
        ? msg.content.substring(0, 200) + '...'
        : msg.content;

      // Replace newlines with visible marker for compact display
      const displayContent = contentPreview.replace(/\n/g, ' ↵ ');

      console.log(`║ [${i + 1}] ${roleLabel}: ${displayContent}`);

      // Log attachment info if present
      if (msg.metadata?.attachments && msg.metadata.attachments.length > 0) {
        console.log(`║     └─ Attachments: ${msg.metadata.attachments.length} file(s)`);
      }
    }

    console.log(`╚══════════════════════════════════════════════════════════════════════════════\n`);
  }
}
