/**
 * SignalAfferent - Manages WebSocket connection to Signal CLI REST API
 *
 * Runs asynchronously outside the frame boundary, bridging external Signal
 * events to Connectome's event system.
 */

import WebSocket from 'ws';
import { BaseAfferent } from 'connectome-ts';
import type { AfferentContext } from 'connectome-ts';

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
        source: { elementId: this.element?.id || 'signal-afferent', elementPath: [] },
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

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      console.log(`[SignalAfferent ${botPhone}] Downloaded attachment: ${base64.length} bytes (base64)`);
      return base64;
    } catch (error) {
      console.error(`[SignalAfferent ${botPhone}] Error downloading attachment:`, error);
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
            // Download image and convert to base64
            const base64Data = await this.downloadAttachment(attachment.id);
            if (base64Data) {
              processedAttachments.push({
                id: attachment.id,
                contentType: attachment.contentType,
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

        this.emit({
          topic: 'signal:message',
          source: { elementId: this.element?.id || 'signal-afferent', elementPath: [] },
          timestamp,
          payload: {
            botPhone,
            source,
            sourceUuid,
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
      } else if (receiptMessage.when) {
        // Receipt (read/delivery confirmation)
        this.emit({
          topic: 'signal:receipt',
          source: { elementId: this.element?.id || 'signal-afferent', elementPath: [] },
          timestamp,
          payload: {
            botPhone,
            source,
            sourceUuid,
            when: receiptMessage.when,
            isDelivery: receiptMessage.isDelivery,
            isRead: receiptMessage.isRead,
            timestamps: receiptMessage.timestamps
          }
        });
      } else if (typingMessage) {
        // Typing indicator
        this.emit({
          topic: 'signal:typing',
          source: { elementId: this.element?.id || 'signal-afferent', elementPath: [] },
          timestamp,
          payload: {
            botPhone,
            source,
            sourceUuid,
            groupId: typingMessage.groupId,
            action: typingMessage.action // 'STARTED' or 'STOPPED'
          }
        });
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.error(`[SignalAfferent ${botPhone}] Failed to parse JSON:`, data);
      } else {
        console.error(`[SignalAfferent ${botPhone}] Error handling message:`, error);
      }
    }
  }
}
