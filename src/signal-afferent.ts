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

    ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data.toString());
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

  private handleMessage(data: string): void {
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
        this.emit({
          topic: 'signal:message',
          source: { elementId: this.element?.id || 'signal-afferent', elementPath: [] },
          timestamp,
          payload: {
            botPhone,
            source,
            sourceUuid,
            groupId: dataMessage.groupInfo?.groupId,
            message: dataMessage.message || '',
            attachments: dataMessage.attachments || [],
            mentions: dataMessage.mentions || [],
            quote: dataMessage.quote,
            timestamp: envelope.timestamp,
            rawEnvelope: envelope
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
