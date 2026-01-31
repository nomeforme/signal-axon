/**
 * SignalAfferent - Manages WebSocket connection to Signal CLI REST API
 *
 * Runs asynchronously outside the frame boundary, bridging external Signal
 * events to Connectome's event system.
 */

import WebSocket from 'ws';
import sharp from 'sharp';
import { BaseAfferent } from 'connectome-ts';
import type { AfferentContext } from 'connectome-ts';
import { messageDeduplicator } from './message-deduplicator.js';

// Image compression settings
const IMAGE_MAX_DIMENSION = 1024;  // Max width or height
const IMAGE_JPEG_QUALITY = 80;    // JPEG quality (1-100)

export interface SignalAfferentConfig {
  botPhone: string;
  wsUrl: string;
  httpUrl?: string; // HTTP base URL for downloading attachments
  maxReconnectTime?: number; // milliseconds, default 5 minutes
}

interface WebSocketState {
  ws?: WebSocket;
  connected: boolean;
  retryCount: number;
  firstReconnectAttempt?: number;
}

/**
 * SignalAfferent manages the WebSocket connection to Signal CLI
 * and emits events when messages arrive.
 */
export class SignalAfferent extends BaseAfferent<SignalAfferentConfig> {
  private state: WebSocketState = {
    connected: false,
    retryCount: 0
  };

  private maxReconnectTime: number = 5 * 60 * 1000; // 5 minutes

  async onInitialize(): Promise<void> {
    this.maxReconnectTime = this.context.config.maxReconnectTime || this.maxReconnectTime;
    console.log(`[SignalAfferent ${this.context.config.botPhone}] Initialized`);
  }

  async onCommand(_command: any): Promise<void> {
    // No commands supported yet
  }

  async onDestroyAfferent(): Promise<void> {
    await this.onStop();
  }

  async onStart(): Promise<void> {
    await this.connect();
  }

  async onStop(): Promise<void> {
    if (this.state.ws) {
      this.state.ws.close();
      this.state.ws = undefined;
    }
    this.state.connected = false;
    console.log(`[SignalAfferent ${this.context.config.botPhone}] Stopped`);
  }

  private async connect(): Promise<void> {
    const { botPhone, wsUrl } = this.context.config;
    const url = `${wsUrl}/v1/receive/${botPhone}`;

    console.log(`[SignalAfferent ${botPhone}] Connecting to ${url}`);

    const ws = new WebSocket(url);
    this.state.ws = ws;

    ws.on('open', () => {
      console.log(`[SignalAfferent ${botPhone}] WebSocket connected`);
      this.state.connected = true;
      this.state.retryCount = 0;
      this.state.firstReconnectAttempt = undefined;
    });

    ws.on('message', async (data: WebSocket.Data) => {
      await this.handleMessage(data.toString());
    });

    ws.on('error', (error: Error) => {
      console.error(`[SignalAfferent ${botPhone}] WebSocket error:`, error.message);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      console.log(`[SignalAfferent ${botPhone}] WebSocket closed: ${code} - ${reason.toString()}`);
      this.state.connected = false;

      // Attempt reconnection with exponential backoff
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const { botPhone } = this.context.config;
    const now = Date.now();

    // Track first reconnection attempt
    if (this.state.retryCount === 0) {
      this.state.firstReconnectAttempt = now;
    }

    // Check if we've exceeded max reconnection time
    const firstAttemptTime = this.state.firstReconnectAttempt || now;
    const elapsedTime = now - firstAttemptTime;

    if (elapsedTime >= this.maxReconnectTime) {
      console.error(`[SignalAfferent ${botPhone}] Max reconnection time (5 minutes) exceeded. Giving up.`);
      this.state.retryCount = 0;
      this.state.firstReconnectAttempt = undefined;

      // Emit error event
      this.emit({
        topic: 'afferent:error',
        source: this.getRef(),
        timestamp: Date.now(),
        payload: {
          afferentId: this.context.afferentId,
          errorType: 'CONNECTION_TIMEOUT',
          message: 'Max reconnection time exceeded',
          recoverable: false
        }
      });
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const backoffDelay = Math.min(1000 * Math.pow(2, this.state.retryCount), 30000);
    const remainingTime = Math.ceil((this.maxReconnectTime - elapsedTime) / 1000);

    console.log(`[SignalAfferent ${botPhone}] Reconnecting in ${backoffDelay}ms (${remainingTime}s remaining)...`);

    setTimeout(() => {
      this.state.retryCount++;
      this.connect();
    }, backoffDelay);
  }

  /**
   * Download an attachment from Signal API and return as base64
   */
  private async downloadAttachment(attachmentId: string): Promise<string | null> {
    const { botPhone, httpUrl } = this.context.config;

    if (!httpUrl) {
      console.warn(`[SignalAfferent ${botPhone}] No httpUrl configured, cannot download attachment`);
      return null;
    }

    try {
      const url = `${httpUrl}/v1/attachments/${attachmentId}`;
      console.log(`[SignalAfferent ${botPhone}] Downloading attachment from ${url}`);

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[SignalAfferent ${botPhone}] Failed to download attachment: ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const originalSize = buffer.length;

      // Compress image: resize to max dimension and convert to JPEG
      const compressed = await this.compressImage(buffer);
      if (compressed) {
        const base64 = compressed.toString('base64');
        console.log(`[SignalAfferent ${botPhone}] Downloaded and compressed attachment: ${originalSize} -> ${compressed.length} bytes (${Math.round(compressed.length / originalSize * 100)}%)`);
        return base64;
      }

      // Fallback to original if compression fails
      const base64 = buffer.toString('base64');
      console.log(`[SignalAfferent ${botPhone}] Downloaded attachment (uncompressed): ${base64.length} bytes (base64)`);
      return base64;
    } catch (error) {
      console.error(`[SignalAfferent ${botPhone}] Error downloading attachment:`, error);
      return null;
    }
  }

  /**
   * Compress an image: resize to max dimension and convert to JPEG
   * Returns null if compression fails (e.g., unsupported format)
   */
  private async compressImage(buffer: Buffer): Promise<Buffer | null> {
    const { botPhone } = this.context.config;

    try {
      // Get image metadata
      const metadata = await sharp(buffer).metadata();
      const { width, height, format } = metadata;

      if (!width || !height) {
        console.log(`[SignalAfferent ${botPhone}] Could not get image dimensions, skipping compression`);
        return null;
      }

      // Check if resizing is needed
      const maxDim = Math.max(width, height);
      const needsResize = maxDim > IMAGE_MAX_DIMENSION;

      // Skip compression for small images that are already JPEG
      if (!needsResize && format === 'jpeg') {
        console.log(`[SignalAfferent ${botPhone}] Image already optimized (${width}x${height} ${format})`);
        return buffer;
      }

      // Build sharp pipeline
      let pipeline = sharp(buffer);

      // Resize if needed (maintain aspect ratio)
      if (needsResize) {
        pipeline = pipeline.resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      // Convert to JPEG
      const compressed = await pipeline
        .jpeg({ quality: IMAGE_JPEG_QUALITY })
        .toBuffer();

      console.log(`[SignalAfferent ${botPhone}] Compressed image: ${width}x${height} ${format} -> JPEG (${needsResize ? 'resized' : 'same size'})`);
      return compressed;
    } catch (error) {
      console.error(`[SignalAfferent ${botPhone}] Image compression failed:`, error);
      return null;
    }
  }

  private async handleMessage(data: string): Promise<void> {
    const { botPhone } = this.context.config;

    console.log(`[SignalAfferent ${botPhone}] Received WebSocket message:`, data.substring(0, 200));

    try {
      const message = JSON.parse(data);
      const envelope = message.envelope || {};

      console.log(`[SignalAfferent ${botPhone}] Parsed envelope:`, JSON.stringify(envelope, null, 2).substring(0, 500));

      // Extract basic message info
      const source = envelope.source || envelope.sourceNumber || 'unknown';
      const sourceUuid = envelope.sourceUuid || '';
      const sourceName = envelope.sourceName || ''; // Signal display name
      const timestamp = envelope.timestamp || Date.now();
      const dataMessage = envelope.dataMessage || {};
      const receiptMessage = envelope.receiptMessage || {};
      const typingMessage = envelope.typingMessage || {};

      // Determine message type and emit appropriate event
      if (dataMessage.message !== undefined || dataMessage.attachments) {
        // Regular message
        console.log(`[SignalAfferent ${botPhone}] Emitting signal:message event - from: ${source}, message: "${dataMessage.message}"`);

        // Debug: Log mentions if present
        if (dataMessage.mentions && dataMessage.mentions.length > 0) {
          console.log(`[SignalAfferent ${botPhone}] dataMessage.mentions:`, JSON.stringify(dataMessage.mentions));
        }

        // Process attachments - download images and convert to base64
        const rawAttachments = dataMessage.attachments || [];
        const processedAttachments = [];

        for (const attachment of rawAttachments) {
          const contentType = attachment.contentType || '';
          const isImage = contentType.startsWith('image/');

          if (isImage && attachment.id) {
            // Download image, compress, and convert to base64
            const base64Data = await this.downloadAttachment(attachment.id);
            if (base64Data) {
              processedAttachments.push({
                id: attachment.id,
                contentType: 'image/jpeg',  // Always JPEG after compression
                filename: attachment.filename,
                size: attachment.size,
                data: base64Data
              });
            } else {
              // Failed to download, include metadata only
              processedAttachments.push({
                id: attachment.id,
                contentType: attachment.contentType,
                filename: attachment.filename,
                size: attachment.size
              });
            }
          } else {
            // Non-image attachment, include metadata only
            processedAttachments.push({
              id: attachment.id,
              contentType: attachment.contentType,
              filename: attachment.filename,
              size: attachment.size
            });
          }
        }

        // Build stream ID for this conversation
        // Check both groupInfo and groupV2 (Signal uses different fields for different group versions)
        const groupInfo = dataMessage.groupInfo || dataMessage.groupV2;
        const groupId = groupInfo?.groupId;
        const conversationKey = groupId || source;
        const isGroupChat = !!groupId;
        // For DMs, include botPhone in streamId so each bot has its own stream with the user
        // For groups, just use the groupId since all bots share the same group conversation
        // This MUST match the receptor's streamId generation!
        const streamId = isGroupChat
          ? `signal-stream-${conversationKey}`
          : `signal-stream-${botPhone}-${conversationKey}`;
        const streamType = 'signal';

        // Deduplicate group messages - only first bot to receive emits an event
        // This reduces frame creation from N bots to 1 per group message
        const messageId = `${source}-${timestamp}`;
        if (!messageDeduplicator.shouldEmit(messageId, botPhone, isGroupChat)) {
          console.log(`[SignalAfferent ${botPhone}] Skipping duplicate group message ${messageId.substring(0, 50)}...`);
          return;
        }

        this.emit({
          topic: 'signal:message',
          source: this.getRef(),
          timestamp,
          payload: {
            botPhone,
            source,
            sourceUuid,
            sourceName, // Signal display name
            groupId,
            message: dataMessage.message || '',
            attachments: processedAttachments,
            mentions: dataMessage.mentions || [],
            quote: dataMessage.quote,
            timestamp: envelope.timestamp,
            rawEnvelope: envelope,
            streamId,
            streamType
          }
        });
      }
      // Skip receipts and typing indicators - they create frames but don't
      // contribute to conversation context, causing unnecessary overhead.
      // Receipt: receiptMessage.when (delivery/read confirmations)
      // Typing: typingMessage (typing indicators)
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.error(`[SignalAfferent ${botPhone}] Failed to parse JSON:`, data);
      } else {
        console.error(`[SignalAfferent ${botPhone}] Error handling message:`, error);
      }
    }
  }
}
