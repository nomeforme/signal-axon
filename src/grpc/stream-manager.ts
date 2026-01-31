/**
 * Stream Manager for Signal gRPC Client
 * Manages subscriptions and stream state for Signal conversations
 */

import { SignalGrpcClient } from './client.js';
import { EventEmitter } from 'events';

/**
 * Stream information
 */
export interface StreamInfo {
  streamId: string;
  conversationType: 'dm' | 'group';
  groupId?: string;
  groupName?: string;
  contactNumber?: string;
  contactUuid?: string;
  botPhone: string;
  participants: string[];
  createdAt: number;
  lastMessageAt: number;
}

/**
 * Manages streams and subscriptions for Signal conversations
 */
export class StreamManager extends EventEmitter {
  private client: SignalGrpcClient;
  private streams: Map<string, StreamInfo> = new Map();
  private unsubscribes: Map<string, () => void> = new Map();
  private speechCallback?: (facet: any, streamInfo: StreamInfo) => void;

  constructor(client: SignalGrpcClient) {
    super();
    this.client = client;
  }

  /**
   * Register a callback for speech facets
   */
  onSpeech(callback: (facet: any, streamInfo: StreamInfo) => void): void {
    this.speechCallback = callback;
  }

  /**
   * Get or create a stream for a conversation
   */
  async getOrCreateStream(
    conversationId: string,
    metadata: {
      conversationType: 'dm' | 'group';
      groupId?: string;
      groupName?: string;
      contactNumber?: string;
      contactUuid?: string;
      botPhone: string;
      participants?: string[];
    }
  ): Promise<StreamInfo> {
    const streamId = this.buildStreamId(conversationId, metadata);

    // Check if stream already exists locally
    let info = this.streams.get(streamId);
    if (info) {
      // Update last message time
      info.lastMessageAt = Date.now();
      return info;
    }

    // Create new stream on server (pass full streamId, not conversationId)
    await this.client.ensureStream(streamId, {
      groupName: metadata.groupName,
      participants: metadata.participants,
      botPhone: metadata.botPhone
    });

    // Store stream info locally
    info = {
      streamId,
      conversationType: metadata.conversationType,
      groupId: metadata.groupId,
      groupName: metadata.groupName,
      contactNumber: metadata.contactNumber,
      contactUuid: metadata.contactUuid,
      botPhone: metadata.botPhone,
      participants: metadata.participants || [],
      createdAt: Date.now(),
      lastMessageAt: Date.now()
    };

    this.streams.set(streamId, info);

    // Subscribe to speech for this stream
    this.subscribeToStream(streamId);

    console.log(`[StreamManager] Created stream: ${streamId}`);

    return info;
  }

  /**
   * Build stream ID from conversation metadata
   * For DMs: includes botPhone to isolate each bot's conversation with a user
   * For groups: just uses group ID (all bots share same group context)
   */
  private buildStreamId(
    conversationId: string,
    metadata: { conversationType: 'dm' | 'group'; groupId?: string; contactNumber?: string; contactUuid?: string; botPhone?: string }
  ): string {
    if (metadata.conversationType === 'group' && metadata.groupId) {
      return `signal:group:${metadata.groupId}`;
    } else if (metadata.botPhone && (metadata.contactNumber || metadata.contactUuid)) {
      // Include bot phone in DM stream ID for per-bot isolation
      const contact = metadata.contactNumber || metadata.contactUuid;
      return `signal:dm:${metadata.botPhone}:${contact}`;
    } else if (metadata.contactNumber) {
      return `signal:dm:${metadata.contactNumber}`;
    } else if (metadata.contactUuid) {
      return `signal:dm:${metadata.contactUuid}`;
    } else {
      return `signal:${conversationId}`;
    }
  }

  /**
   * Subscribe to a specific stream
   */
  private subscribeToStream(streamId: string): void {
    // Avoid duplicate subscriptions
    if (this.unsubscribes.has(streamId)) {
      return;
    }

    const unsubscribe = this.client.subscribeToSpeech(
      (facet) => {
        const info = this.streams.get(streamId);
        if (info && this.speechCallback) {
          this.speechCallback(facet, info);
        }
        this.emit('speech', facet, info);
      },
      {
        streamIds: [streamId]
      }
    );

    this.unsubscribes.set(streamId, unsubscribe);
  }

  /**
   * Get stream by ID
   */
  getStream(streamId: string): StreamInfo | undefined {
    return this.streams.get(streamId);
  }

  /**
   * Get stream for a group
   */
  getStreamByGroupId(groupId: string): StreamInfo | undefined {
    const streamId = `signal:group:${groupId}`;
    return this.streams.get(streamId);
  }

  /**
   * Get stream for a DM
   */
  getStreamByContact(contactNumber: string): StreamInfo | undefined {
    const streamId = `signal:dm:${contactNumber}`;
    return this.streams.get(streamId);
  }

  /**
   * Get all active streams
   */
  getAllStreams(): StreamInfo[] {
    return Array.from(this.streams.values());
  }

  /**
   * Get streams for a specific bot
   */
  getStreamsForBot(botPhone: string): StreamInfo[] {
    return this.getAllStreams().filter(s => s.botPhone === botPhone);
  }

  /**
   * Clean up inactive streams
   */
  cleanupInactiveStreams(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let cleaned = 0;

    for (const [streamId, info] of this.streams) {
      if (info.lastMessageAt < cutoff) {
        // Unsubscribe
        const unsub = this.unsubscribes.get(streamId);
        if (unsub) {
          unsub();
          this.unsubscribes.delete(streamId);
        }

        // Remove stream
        this.streams.delete(streamId);
        cleaned++;

        console.log(`[StreamManager] Cleaned up inactive stream: ${streamId}`);
      }
    }

    return cleaned;
  }

  /**
   * Unsubscribe from all streams
   */
  unsubscribeAll(): void {
    for (const [streamId, unsub] of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes.clear();
  }

  /**
   * Get stats
   */
  getStats(): {
    totalStreams: number;
    dmStreams: number;
    groupStreams: number;
    activeSubscriptions: number;
  } {
    const streams = this.getAllStreams();
    return {
      totalStreams: streams.length,
      dmStreams: streams.filter(s => s.conversationType === 'dm').length,
      groupStreams: streams.filter(s => s.conversationType === 'group').length,
      activeSubscriptions: this.unsubscribes.size
    };
  }
}
