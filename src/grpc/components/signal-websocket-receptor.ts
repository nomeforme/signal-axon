/**
 * SignalWebSocketReceptor - Handles WebSocket connection to Signal CLI
 *
 * Manages the WebSocket connection to Signal CLI's receive endpoint:
 * - Connects and maintains connection with auto-reconnect
 * - Parses incoming envelopes (messages, receipts, typing)
 * - Emits parsed events to registered handlers
 *
 * This is the gRPC client-side equivalent - it handles the raw Signal CLI
 * connection, not the Connectome server.
 */

import WebSocket from 'ws';
import type { SignalMessageEvent, SignalAttachment, SignalMention, SignalQuote } from '../types.js';

export interface SignalWebSocketReceptorConfig {
  wsUrl: string;
  botPhone: string;
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
  private botPhone: string;
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
    this.botPhone = config.botPhone;
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
   */
  private async handleDataMessage(env: any): Promise<void> {
    const dataMessage = env.dataMessage;
    const source = env.source || env.sourceNumber;
    const sourceUuid = env.sourceUuid;

    // Skip messages from bots
    if (this.isBotUuid(sourceUuid)) {
      console.log(`[SignalWebSocketReceptor:${this.botPhone}] Skipping message from bot ${sourceUuid}`);
      return;
    }

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
      attachments: this.parseAttachments(dataMessage.attachments),
      mentions: this.parseMentions(dataMessage.mentions),
      quotedMessage: this.parseQuote(dataMessage.quote)
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
   * Parse attachments from Signal format
   */
  private parseAttachments(attachments: any[] | undefined): SignalAttachment[] | undefined {
    if (!attachments || attachments.length === 0) return undefined;

    return attachments.map(att => ({
      id: att.id,
      contentType: att.contentType,
      filename: att.filename,
      size: att.size
    }));
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
