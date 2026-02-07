/**
 * SignalWebSocketReceptor - Handles WebSocket connection to Signal CLI
 *
 * Manages the WebSocket connection to Signal CLI's receive endpoint:
 * - Connects and maintains connection with auto-reconnect
 * - Parses incoming envelopes (messages, receipts, typing)
 * - Downloads and compresses image attachments
 * - Emits parsed events to registered handlers
 *
 * This is the gRPC client-side equivalent - it handles the raw Signal CLI
 * connection, not the Connectome server.
 */

import WebSocket from 'ws';
import sharp from 'sharp';
import type { SignalMessageEvent, SignalAttachment, SignalMention, SignalQuote } from '../types.js';

// Image compression settings
const IMAGE_MAX_DIMENSION = 1024;  // Max width or height
const IMAGE_JPEG_QUALITY = 80;    // JPEG quality (1-100)
const IMAGE_MAX_BYTES = 3_500_000; // Max compressed size before base64 (~4.7MB base64, under 5MB API limit)

export interface SignalWebSocketReceptorConfig {
  wsUrl: string;
  httpUrl: string;  // HTTP base URL for downloading attachments
  botPhone: string;
  botUuid?: string;  // THIS bot's UUID (for checking if mentioned)
  botUuids?: Map<string, string>;  // All bot UUIDs for bot message detection
  onMessage: (event: SignalMessageEvent) => Promise<void>;
  onReceipt: (receipt: SignalReceiptEvent) => Promise<void>;
  onTyping: (typing: SignalTypingEvent) => Promise<void>;
}

export interface SignalReceiptEvent {
  type: 'read' | 'delivered';
  sender: string;
  senderNumber?: string;
  senderUuid?: string;
  timestamp: number;
  botPhone: string;
}

export interface SignalTypingEvent {
  sender: string;
  senderNumber?: string;
  senderUuid?: string;
  groupId?: string;
  started: boolean;
  timestamp: number;
  botPhone: string;
}

/**
 * SignalWebSocketReceptor - Manages Signal CLI WebSocket connection
 *
 * Constraint equivalent: AFFERENT (external input handler)
 */
export class SignalWebSocketReceptor {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private httpUrl: string;
  private botPhone: string;
  private botUuid: string | undefined;
  private botUuids: Map<string, string>;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectDelay: number = 5000;
  private maxReconnectDelay: number = 5 * 60 * 1000;  // 5 minutes
  private connected: boolean = false;

  private onMessage: (event: SignalMessageEvent) => Promise<void>;
  private onReceipt: (receipt: SignalReceiptEvent) => Promise<void>;
  private onTyping: (typing: SignalTypingEvent) => Promise<void>;

  constructor(config: SignalWebSocketReceptorConfig) {
    this.wsUrl = config.wsUrl;
    this.httpUrl = config.httpUrl;
    this.botPhone = config.botPhone;
    this.botUuid = config.botUuid;
    this.botUuids = config.botUuids || new Map();
    this.onMessage = config.onMessage;
    this.onReceipt = config.onReceipt;
    this.onTyping = config.onTyping;
  }

  /**
   * Get bot phone
   */
  getBotPhone(): string {
    return this.botPhone;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to Signal CLI WebSocket
   */
  connect(): void {
    const url = `${this.wsUrl}/v1/receive/${encodeURIComponent(this.botPhone)}`;
    console.log(`[SignalWebSocketReceptor:${this.botPhone}] Connecting to ${url}...`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 5000;  // Reset reconnect delay on successful connection
      console.log(`[SignalWebSocketReceptor:${this.botPhone}] Connected`);
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const envelope = JSON.parse(data.toString());
        this.handleEnvelope(envelope);
      } catch (error) {
        console.error(`[SignalWebSocketReceptor:${this.botPhone}] Error parsing message:`, error);
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      console.log(`[SignalWebSocketReceptor:${this.botPhone}] Disconnected`);
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error(`[SignalWebSocketReceptor:${this.botPhone}] Error:`, error);
    });
  }

  /**
   * Disconnect from Signal CLI
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
  }

  /**
   * Handle incoming envelope from Signal CLI
   */
  private async handleEnvelope(envelope: any): Promise<void> {
    const env = envelope.envelope;
    if (!env) return;

    // Handle data messages
    if (env.dataMessage) {
      await this.handleDataMessage(env);
    }

    // Handle receipts
    if (env.receiptMessage) {
      await this.handleReceiptMessage(env);
    }

    // Handle typing indicators
    if (env.typingMessage) {
      await this.handleTypingMessage(env);
    }
  }

  /**
   * Handle data message (regular text/media message)
   *
   * IMPORTANT: Forward ALL messages to the message receptor.
   * The message receptor decides what to do with them:
   * - Which messages to emit to Connectome (all non-`.` prefixed messages)
   * - Which messages should trigger agent activation (mentions/quotes)
   */
  private async handleDataMessage(env: any): Promise<void> {
    const dataMessage = env.dataMessage;
    const source = env.source || env.sourceNumber;
    const sourceUuid = env.sourceUuid;

    const mentions = dataMessage.mentions || [];
    const quote = dataMessage.quote;

    // Debug logging for quote data from Signal CLI
    if (quote) {
      console.log(`[SignalWebSocketReceptor:${this.botPhone}] Raw quote data: id=${quote.id}, author=${quote.author}, authorUuid=${quote.authorUuid}, text=${quote.text?.substring(0, 30)}...`);
    }

    // Log bot messages for debugging, but forward ALL messages to handler
    if (this.isBotUuid(sourceUuid)) {
      console.log(`[SignalWebSocketReceptor:${this.botPhone}] Forwarding bot message from ${sourceUuid} to message receptor`);
    }

    // Process attachments (downloads images and converts to base64)
    const attachments = await this.parseAttachments(dataMessage.attachments);

    // Build message event
    const event: SignalMessageEvent = {
      content: dataMessage.message || '',
      sender: env.sourceName || source || 'Unknown',
      senderNumber: env.sourceNumber,
      senderUuid: sourceUuid,
      groupId: dataMessage.groupInfo?.groupId,
      groupName: dataMessage.groupInfo?.groupName,
      botPhone: this.botPhone,
      timestamp: dataMessage.timestamp,
      attachments,
      mentions: this.parseMentions(mentions),
      quotedMessage: this.parseQuote(quote)
    };

    try {
      await this.onMessage(event);
    } catch (error) {
      console.error(`[SignalWebSocketReceptor:${this.botPhone}] Error handling message:`, error);
    }
  }

  /**
   * Handle receipt message
   */
  private async handleReceiptMessage(env: any): Promise<void> {
    const receipt = env.receiptMessage;

    const event: SignalReceiptEvent = {
      type: receipt.isRead ? 'read' : 'delivered',
      sender: env.source || env.sourceNumber || 'Unknown',
      senderNumber: env.sourceNumber,
      senderUuid: env.sourceUuid,
      timestamp: receipt.timestamps?.[0] || Date.now(),
      botPhone: this.botPhone
    };

    try {
      await this.onReceipt(event);
    } catch (error) {
      console.error(`[SignalWebSocketReceptor:${this.botPhone}] Error handling receipt:`, error);
    }
  }

  /**
   * Handle typing message
   */
  private async handleTypingMessage(env: any): Promise<void> {
    const typing = env.typingMessage;

    const event: SignalTypingEvent = {
      sender: env.source || env.sourceNumber || 'Unknown',
      senderNumber: env.sourceNumber,
      senderUuid: env.sourceUuid,
      groupId: typing.groupId,
      started: typing.action === 'STARTED',
      timestamp: typing.timestamp || Date.now(),
      botPhone: this.botPhone
    };

    try {
      await this.onTyping(event);
    } catch (error) {
      console.error(`[SignalWebSocketReceptor:${this.botPhone}] Error handling typing:`, error);
    }
  }

  /**
   * Check if UUID belongs to a bot
   */
  private isBotUuid(uuid: string | undefined): boolean {
    if (!uuid) return false;

    for (const [, botUuid] of this.botUuids) {
      if (botUuid === uuid) return true;
    }

    return false;
  }

  /**
   * Parse and process attachments from Signal format
   * Downloads images and converts to base64
   */
  private async parseAttachments(attachments: any[] | undefined): Promise<SignalAttachment[] | undefined> {
    if (!attachments || attachments.length === 0) return undefined;

    const processedAttachments: SignalAttachment[] = [];

    for (const att of attachments) {
      const contentType = att.contentType || '';
      const isImage = contentType.startsWith('image/');

      if (isImage && att.id) {
        // Download image, compress, and convert to base64
        const base64Data = await this.downloadAttachment(att.id);
        if (base64Data) {
          processedAttachments.push({
            id: att.id,
            contentType: 'image/jpeg',  // Always JPEG after compression
            filename: att.filename,
            size: att.size,
            data: base64Data
          });
        } else {
          // Failed to download, include metadata only
          processedAttachments.push({
            id: att.id,
            contentType: att.contentType,
            filename: att.filename,
            size: att.size
          });
        }
      } else {
        // Non-image attachment, include metadata only
        processedAttachments.push({
          id: att.id,
          contentType: att.contentType,
          filename: att.filename,
          size: att.size
        });
      }
    }

    return processedAttachments.length > 0 ? processedAttachments : undefined;
  }

  /**
   * Download an attachment from Signal CLI HTTP API and return as base64
   */
  private async downloadAttachment(attachmentId: string): Promise<string | null> {
    if (!this.httpUrl) {
      console.warn(`[SignalWebSocketReceptor:${this.botPhone}] No httpUrl configured, cannot download attachment`);
      return null;
    }

    try {
      const url = `${this.httpUrl}/v1/attachments/${attachmentId}`;
      console.log(`[SignalWebSocketReceptor:${this.botPhone}] Downloading attachment from ${url}`);

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[SignalWebSocketReceptor:${this.botPhone}] Failed to download attachment: ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const originalSize = buffer.length;

      // Compress image: resize to max dimension and convert to JPEG
      const compressed = await this.compressImage(buffer);
      if (compressed) {
        const base64 = compressed.toString('base64');
        console.log(`[SignalWebSocketReceptor:${this.botPhone}] Downloaded and compressed attachment: ${originalSize} -> ${compressed.length} bytes (${Math.round(compressed.length / originalSize * 100)}%)`);
        return base64;
      }

      // Compression failed - skip rather than sending uncompressed (could exceed API limits)
      console.warn(`[SignalWebSocketReceptor:${this.botPhone}] Compression failed, skipping attachment (${originalSize} bytes)`);
      return null;
    } catch (error) {
      console.error(`[SignalWebSocketReceptor:${this.botPhone}] Error downloading attachment:`, error);
      return null;
    }
  }

  /**
   * Compress an image: resize to max dimension and convert to JPEG
   * Returns null if compression fails (e.g., unsupported format)
   */
  private async compressImage(buffer: Buffer): Promise<Buffer | null> {
    try {
      // Get image metadata
      const metadata = await sharp(buffer).metadata();
      const { width, height, format } = metadata;

      if (!width || !height) {
        console.log(`[SignalWebSocketReceptor:${this.botPhone}] Could not get image dimensions, skipping compression`);
        return null;
      }

      // Check if resizing is needed
      const maxDim = Math.max(width, height);
      const needsResize = maxDim > IMAGE_MAX_DIMENSION;

      // Skip compression for small JPEGs that are already under size limit
      if (!needsResize && format === 'jpeg' && buffer.length <= IMAGE_MAX_BYTES) {
        console.log(`[SignalWebSocketReceptor:${this.botPhone}] Image already optimized (${width}x${height} ${format}, ${buffer.length} bytes)`);
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
      let compressed = await pipeline
        .jpeg({ quality: IMAGE_JPEG_QUALITY })
        .toBuffer();

      // If still too large, recompress with lower quality and smaller dimensions
      if (compressed.length > IMAGE_MAX_BYTES) {
        console.log(`[SignalWebSocketReceptor:${this.botPhone}] First pass too large (${compressed.length} bytes), recompressing`);
        compressed = await sharp(compressed)
          .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 50 })
          .toBuffer();
      }
      if (compressed.length > IMAGE_MAX_BYTES) {
        console.log(`[SignalWebSocketReceptor:${this.botPhone}] Second pass still too large (${compressed.length} bytes), recompressing aggressively`);
        compressed = await sharp(compressed)
          .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 30 })
          .toBuffer();
      }

      console.log(`[SignalWebSocketReceptor:${this.botPhone}] Compressed image: ${width}x${height} ${format} -> JPEG ${compressed.length} bytes (${needsResize ? 'resized' : 'same size'})`);
      return compressed;
    } catch (error) {
      console.error(`[SignalWebSocketReceptor:${this.botPhone}] Image compression failed:`, error);
      return null;
    }
  }

  /**
   * Parse mentions from Signal format
   */
  private parseMentions(mentions: any[] | undefined): SignalMention[] | undefined {
    if (!mentions || mentions.length === 0) return undefined;

    return mentions.map(m => ({
      start: m.start,
      length: m.length,
      uuid: m.uuid
    }));
  }

  /**
   * Parse quote/reply from Signal format
   */
  private parseQuote(quote: any | undefined): SignalQuote | undefined {
    if (!quote) return undefined;

    return {
      id: quote.id,
      author: quote.author,
      authorUuid: quote.authorUuid,
      text: quote.text
    };
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    console.log(`[SignalWebSocketReceptor:${this.botPhone}] Reconnecting in ${this.reconnectDelay / 1000}s...`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
