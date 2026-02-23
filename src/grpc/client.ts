/**
 * Signal AXON gRPC Client
 * Connects signal-axon to the central Connectome gRPC server
 */

import { ConnectomeClient, type ConnectomeClientConfig, type SubscriptionOptions, type FacetDelta } from '@connectome/grpc-common';
import { EventEmitter } from 'events';

/**
 * Signal-specific gRPC client configuration
 */
export interface SignalGrpcClientConfig {
  /** Connectome gRPC server host */
  serverHost: string;
  /** Connectome gRPC server port */
  serverPort?: number;
  /** Client identifier (usually bot name or phone) */
  clientId: string;
  /** Bot name for agent registration */
  botName: string;
  /** Stream type for Signal messages */
  streamType?: string;
}

/**
 * Signal gRPC Client
 * Wraps ConnectomeClient with Signal-specific functionality
 */
export class SignalGrpcClient extends EventEmitter {
  private client: ConnectomeClient;
  private config: SignalGrpcClientConfig;
  private agentHandle?: { agentId: string; sessionToken: string };
  private unsubscribe?: () => void;

  constructor(config: SignalGrpcClientConfig) {
    super();

    this.config = {
      ...config,
      serverPort: config.serverPort || 50051,
      streamType: config.streamType || 'signal'
    };

    const clientConfig: ConnectomeClientConfig = {
      host: this.config.serverHost,
      port: this.config.serverPort,
      clientId: this.config.clientId,
      reconnectInterval: 5000,
      maxReconnectAttempts: -1 // Infinite reconnect
    };

    this.client = new ConnectomeClient(clientConfig);

    // Forward connection events
    this.client.on('connected', () => this.emit('connected'));
    this.client.on('disconnected', () => this.emit('disconnected'));
    this.client.on('reconnected', () => this.emit('reconnected'));
    this.client.on('reconnect_failed', () => this.emit('reconnect_failed'));
    this.client.on('error', (error: Error) => this.emit('error', error));
  }

  /**
   * Connect to the Connectome server and register as an agent
   */
  async connect(): Promise<void> {
    console.log(`[SignalGrpcClient] Connecting to ${this.config.serverHost}:${this.config.serverPort}...`);

    await this.client.connect();

    // Register as an agent
    const result = await this.client.registerAgent(
      `agent-${this.config.clientId}`,
      this.config.botName,
      {
        agentType: 'signal-bot',
        capabilities: ['send-message', 'receive-message', 'mention-detection'],
        metadata: {
          clientId: this.config.clientId,
          streamType: this.config.streamType || 'signal'
        }
      }
    );

    if (!result.success) {
      throw new Error(`Failed to register agent: ${result.error}`);
    }

    this.agentHandle = {
      agentId: result.agentId,
      sessionToken: result.sessionToken
    };

    console.log(`[SignalGrpcClient] Registered agent: ${result.agentId}`);
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }

    this.client.disconnect();
    this.agentHandle = undefined;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.client.isConnected();
  }

  /**
   * Emit a Signal message event
   */
  async emitSignalMessage(message: {
    content: string;
    sender: string;
    senderNumber?: string;
    senderUuid?: string;
    groupId?: string;
    groupName?: string;
    botPhone: string;
    timestamp: number;
    attachments?: any[];
    mentions?: any[];
    quotedMessage?: any;
    metadata?: Record<string, any>;
  }): Promise<{ success: boolean; sequence: number }> {
    // Create stream ID from conversation context
    // Must match signal-message-receptor: DMs include botPhone to isolate per-bot conversations
    const streamId = message.groupId
      ? `signal:group:${message.groupId}`
      : `signal:dm:${message.botPhone}:${message.senderNumber || message.senderUuid}`;

    const result = await this.client.emitEvent(
      'signal:message',
      {
        ...message,
        streamId,
        streamType: 'signal'
      },
      {
        priority: 'high',
        waitForFrame: true,
        metadata: {
          botPhone: message.botPhone,
          streamId
        }
      }
    );

    return {
      success: result.success,
      sequence: result.sequence
    };
  }

  /**
   * Emit a Signal receipt event
   */
  async emitSignalReceipt(receipt: {
    type: 'read' | 'delivered';
    sender: string;
    senderNumber?: string;
    senderUuid?: string;
    timestamp: number;
    botPhone: string;
  }): Promise<{ success: boolean }> {
    const result = await this.client.emitEvent(
      'signal:receipt',
      receipt,
      {
        priority: 'low',
        waitForFrame: false
      }
    );

    return { success: result.success };
  }

  /**
   * Emit a Signal typing event
   */
  async emitSignalTyping(typing: {
    sender: string;
    groupId?: string;
    started: boolean;
    timestamp: number;
    botPhone: string;
  }): Promise<{ success: boolean }> {
    const result = await this.client.emitEvent(
      'signal:typing',
      typing,
      {
        priority: 'low',
        waitForFrame: false
      }
    );

    return { success: result.success };
  }

  /**
   * Subscribe to speech facets for outgoing messages
   */
  subscribeToSpeech(
    callback: (facet: any) => void,
    options?: {
      streamIds?: string[];
      agentName?: string;
    }
  ): () => void {
    const subOptions: SubscriptionOptions = {
      filters: [
        {
          types: ['speech'],
          aspectMatch: options?.agentName ? { agentName: options.agentName } : {}
        }
      ],
      includeExisting: false,
      streamIds: options?.streamIds || []
    };

    const unsub = this.client.subscribe(subOptions, (delta: FacetDelta) => {
      if (delta.type === 'added' && delta.facet) {
        callback(delta.facet);
      }
    });

    this.unsubscribe = unsub;
    return unsub || (() => {});
  }

  /**
   * Get rendered context for the agent
   */
  async getContext(
    streamId: string,
    options?: {
      maxFrames?: number;
    }
  ): Promise<any> {
    if (!this.agentHandle) {
      throw new Error('Not connected - call connect() first');
    }

    const result = await this.client.getContext(
      this.agentHandle.agentId,
      streamId,
      {
        maxFrames: options?.maxFrames || 100
      }
    );

    return result.context;
  }

  /**
   * Create or get a stream for a conversation
   */
  async ensureStream(
    streamId: string,
    metadata?: {
      groupName?: string;
      participants?: string[];
      botPhone?: string;
    }
  ): Promise<string> {
    // streamId should already be in correct format: signal:group:xxx or signal:dm:xxx
    const conversationType = streamId.includes(':group:') ? 'group' : 'dm';

    await this.client.createStream(streamId, 'signal', {
      conversationType,
      groupName: metadata?.groupName || '',
      participants: JSON.stringify(metadata?.participants || []),
      botPhone: metadata?.botPhone || ''
    });

    return streamId;
  }

  /**
   * Emit a generic event to the server
   */
  async emitEvent(
    topic: string,
    payload: Record<string, any>,
    options?: {
      priority?: 'low' | 'normal' | 'high';
      waitForFrame?: boolean;
    }
  ): Promise<{ success: boolean; sequence: number }> {
    const result = await this.client.emitEvent(
      topic,
      payload,
      {
        priority: options?.priority || 'normal',
        waitForFrame: options?.waitForFrame ?? true
      }
    );

    return {
      success: result.success,
      sequence: result.sequence
    };
  }

  /**
   * Activate agent for a stream
   */
  async activateAgent(
    streamId: string,
    reason?: string
  ): Promise<{ success: boolean; activationId: string }> {
    if (!this.agentHandle) {
      throw new Error('Not connected - call connect() first');
    }

    const result = await this.client.activateAgent(
      this.agentHandle.agentId,
      streamId,
      {
        reason: reason || 'signal message received',
        priority: 'normal'
      }
    );

    return {
      success: result.success,
      activationId: result.activationId
    };
  }

  /**
   * Get current health status
   */
  async health(): Promise<{
    healthy: boolean;
    currentSequence: number;
  }> {
    const status = await this.client.health();
    return {
      healthy: status.healthy,
      currentSequence: status.currentSequence
    };
  }

  /**
   * Get the agent ID
   */
  getAgentId(): string | undefined {
    return this.agentHandle?.agentId;
  }
}
