/**
 * Signal Afferent - Manages WebSocket connection to Signal CLI
 *
 * This is the AXON module version of the Signal WebSocket receptor.
 * It follows the same pattern as discord-afferent.ts:
 * - Extends BaseAfferent from the AXON environment
 * - Handles external input (Signal CLI WebSocket messages)
 * - Emits events when messages arrive
 * - Processes commands (send, listGroups, etc.) through command queue
 * - Does NOT touch VEIL state directly
 */

import type { IAxonEnvironment } from '@connectome/axon-interfaces';

interface SignalConfig {
  wsUrl: string;
  apiUrl: string;
  botPhone: string;
  botName: string;
  scrollbackLimit?: number;
}

interface SignalCommand {
  type: 'send' | 'listGroups' | 'listContacts' | 'sendTyping' | 'sendReceipt';
  groupId?: string;
  recipient?: string;
  message?: string;
  attachments?: string[];
  mentions?: Array<{ start: number; length: number; uuid: string }>;
  quoteId?: number;
  quoteAuthor?: string;
}

interface SignalMention {
  start: number;
  length: number;
  uuid: string;
}

interface SignalAttachment {
  id: string;
  contentType: string;
  filename?: string;
  size?: number;
}

interface SignalQuote {
  id: number;
  author: string;
  authorUuid?: string;
  text?: string;
}

export function createModule(env: IAxonEnvironment): any {
  const { BaseAfferent, WebSocket, persistent, persistable } = env;

  @persistable(1)
  class SignalAfferent extends BaseAfferent<SignalConfig, SignalCommand> {
    // Runtime state only (rebuilt on mount)
    private ws?: any;
    private reconnectTimeout?: any;
    private shouldReconnect = true;
    private connectionAttempts = 0;
    private processedMessagesCache = new Set<string>();
    private initialized = false;

    // Cache for state (rebuilt from component-state in VEIL)
    @persistent
    private joinedGroupsCache: string[] = [];

    @persistent
    private groupNamesCache: Record<string, string> = {};

    @persistent
    private lastReadCache: Record<string, number> = {};

    // Bot identity
    private currentBotPhone?: string;
    private currentBotUuid?: string;
    private currentBotName?: string;

    // Called by AxonLoader when parameters are provided
    async setConnectionParams(params: any): Promise<void> {
      console.log('[SignalAfferent] Setting connection params:', params);

      // Store bot info from params
      if (params.botPhone) {
        this.currentBotPhone = params.botPhone;
        console.log(`[SignalAfferent] Bot phone: ${params.botPhone}`);
      }

      if (params.botName) {
        this.currentBotName = params.botName;
      }

      if (params.botUuid) {
        this.currentBotUuid = params.botUuid;
      }

      // Create context for AXON-loaded afferents
      if (!this.context) {
        (this as any).context = {
          config: {
            wsUrl: params.wsUrl || '',
            apiUrl: params.apiUrl || '',
            botPhone: params.botPhone || '',
            botName: params.botName || '',
            scrollbackLimit: params.scrollbackLimit || 50
          },
          afferentId: 'signal-afferent',
          emit: (event: any) => {
            if (this.space) {
              this.space.emit(event);
            }
          },
          emitError: (error: any) => {
            console.error('[SignalAfferent] Error:', error);
          }
        };
      }

      // Initialize and start immediately since we have everything we need
      if (!this.initialized && this.context && this.currentBotPhone) {
        console.log('[SignalAfferent] Initializing and starting...');
        this.initialized = true;

        await this.initialize(this.context);
        await this.start();
      } else {
        console.warn('[SignalAfferent] Cannot initialize - missing context or botPhone');
      }
    }

    async onMount(): Promise<void> {
      if (this.space) {
        console.log('[SignalAfferent] Mounted - ready for control panel events');
      }
    }

    protected async onInitialize(): Promise<void> {
      console.log('[SignalAfferent] Initializing...');

      // Read state from VEIL component-state facet
      const componentState = this.getComponentState();

      // Populate caches from VEIL state
      this.joinedGroupsCache = componentState.joinedGroups || [];
      this.groupNamesCache = componentState.groupNames || {};
      this.lastReadCache = componentState.lastRead || {};

      console.log('[SignalAfferent] Loaded from VEIL:', {
        joinedGroups: this.joinedGroupsCache.length,
        groupNames: Object.keys(this.groupNamesCache).length,
        lastRead: Object.keys(this.lastReadCache).length
      });
    }

    protected async onStart(): Promise<void> {
      console.log('[SignalAfferent] Starting WebSocket connection...');
      await this.connect();
    }

    protected async onStop(): Promise<void> {
      console.log('[SignalAfferent] Stopping...');
      this.shouldReconnect = false;

      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }

      if (this.ws) {
        this.ws.close(1000, 'Afferent stopping');
        this.ws = undefined;
      }
    }

    protected async onDestroyAfferent(): Promise<void> {
      console.log('[SignalAfferent] Destroyed');
    }

    protected async onCommand(command: SignalCommand): Promise<void> {
      console.log(`[SignalAfferent] Processing command: ${command.type}`);

      const config = this.context.config;

      switch (command.type) {
        case 'send':
          await this.sendMessage(command);
          break;

        case 'listGroups':
          await this.listGroups();
          break;

        case 'listContacts':
          await this.listContacts();
          break;

        case 'sendTyping':
          await this.sendTypingIndicator(command.recipient || command.groupId);
          break;

        case 'sendReceipt':
          // Read receipts handled separately
          break;
      }
    }

    // WebSocket connection management

    private async connect(): Promise<void> {
      if (!WebSocket) {
        console.error('[SignalAfferent] WebSocket not available');
        return;
      }

      const config = this.context.config;
      const url = `${config.wsUrl}/v1/receive/${encodeURIComponent(config.botPhone)}`;
      console.log('[SignalAfferent] Connecting to', url);

      try {
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          console.log('[SignalAfferent] WebSocket connected');
          this.connectionAttempts = 0;

          // Emit connection event
          this.emit({
            topic: 'signal:connected',
            source: { elementId: this.id || 'signal', elementPath: [] },
            timestamp: Date.now(),
            payload: {
              botPhone: config.botPhone,
              botName: config.botName,
              reconnect: this.connectionAttempts > 1
            }
          });
        };

        this.ws.onmessage = async (event: any) => {
          try {
            const envelope = JSON.parse(event.data);
            await this.handleEnvelope(envelope);
          } catch (error) {
            console.error('[SignalAfferent] Failed to parse message:', error);
          }
        };

        this.ws.onerror = (error: any) => {
          console.error('[SignalAfferent] WebSocket error:', error);
          this.handleError('connection', 'WebSocket error', error);
        };

        this.ws.onclose = (event: any) => {
          console.log('[SignalAfferent] WebSocket closed:', event.code, event.reason);

          if (this.shouldReconnect && !event.wasClean && this.running) {
            this.scheduleReconnect();
          }
        };
      } catch (error: any) {
        console.error('[SignalAfferent] Failed to connect:', error);
        this.handleError('fatal', 'Connection failed', error);
        this.scheduleReconnect();
      }
    }

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

    private async handleDataMessage(env: any): Promise<void> {
      const dataMessage = env.dataMessage;
      const source = env.source || env.sourceNumber;
      const sourceUuid = env.sourceUuid;

      const messageId = `${sourceUuid || source}-${dataMessage.timestamp}`;

      if (this.processedMessagesCache.has(messageId)) {
        console.log(`[SignalAfferent] Skipping duplicate message ${messageId}`);
        return;
      }

      // Build stream ID
      const streamId = dataMessage.groupInfo?.groupId
        ? `signal:group:${dataMessage.groupInfo.groupId}`
        : `signal:dm:${this.currentBotPhone}:${env.sourceNumber || sourceUuid}`;

      // Emit message event
      this.emit({
        topic: 'signal:message',
        source: { elementId: this.id || 'signal', elementPath: [] },
        timestamp: Date.now(),
        payload: {
          content: dataMessage.message || '',
          sender: env.sourceName || source || 'Unknown',
          senderNumber: env.sourceNumber,
          senderUuid: sourceUuid,
          groupId: dataMessage.groupInfo?.groupId,
          groupName: dataMessage.groupInfo?.groupName,
          botPhone: this.currentBotPhone,
          timestamp: dataMessage.timestamp,
          attachments: this.parseAttachments(dataMessage.attachments),
          mentions: this.parseMentions(dataMessage.mentions),
          quotedMessage: this.parseQuote(dataMessage.quote),
          streamId,
          streamType: 'signal'
        }
      });

      // Update tracking
      this.processedMessagesCache.add(messageId);

      // Update group name cache
      if (dataMessage.groupInfo?.groupName && dataMessage.groupInfo?.groupId) {
        this.groupNamesCache[dataMessage.groupInfo.groupId] = dataMessage.groupInfo.groupName;
      }
    }

    private async handleReceiptMessage(env: any): Promise<void> {
      const receipt = env.receiptMessage;

      this.emit({
        topic: 'signal:receipt',
        source: { elementId: this.id || 'signal', elementPath: [] },
        timestamp: Date.now(),
        payload: {
          type: receipt.isRead ? 'read' : 'delivered',
          sender: env.source || env.sourceNumber || 'Unknown',
          senderNumber: env.sourceNumber,
          senderUuid: env.sourceUuid,
          timestamp: receipt.timestamps?.[0] || Date.now(),
          botPhone: this.currentBotPhone
        }
      });
    }

    private async handleTypingMessage(env: any): Promise<void> {
      const typing = env.typingMessage;

      this.emit({
        topic: 'signal:typing',
        source: { elementId: this.id || 'signal', elementPath: [] },
        timestamp: Date.now(),
        payload: {
          sender: env.source || env.sourceNumber || 'Unknown',
          senderNumber: env.sourceNumber,
          senderUuid: env.sourceUuid,
          groupId: typing.groupId,
          started: typing.action === 'STARTED',
          timestamp: typing.timestamp || Date.now(),
          botPhone: this.currentBotPhone
        }
      });
    }

    private parseAttachments(attachments: any[] | undefined): SignalAttachment[] | undefined {
      if (!attachments || attachments.length === 0) return undefined;

      return attachments.map(att => ({
        id: att.id,
        contentType: att.contentType,
        filename: att.filename,
        size: att.size
      }));
    }

    private parseMentions(mentions: any[] | undefined): SignalMention[] | undefined {
      if (!mentions || mentions.length === 0) return undefined;

      return mentions.map(m => ({
        start: m.start,
        length: m.length,
        uuid: m.uuid
      }));
    }

    private parseQuote(quote: any | undefined): SignalQuote | undefined {
      if (!quote) return undefined;

      return {
        id: quote.id,
        author: quote.author,
        authorUuid: quote.authorUuid,
        text: quote.text
      };
    }

    private scheduleReconnect(): void {
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
      }

      const delay = Math.min(1000 * Math.pow(2, this.connectionAttempts), 30000);
      this.connectionAttempts++;

      console.log(`[SignalAfferent] Reconnecting in ${delay}ms (attempt ${this.connectionAttempts})`);

      this.reconnectTimeout = setTimeout(() => {
        if (this.running) {
          this.connect();
        }
      }, delay);
    }

    // API methods

    private async sendMessage(command: SignalCommand): Promise<void> {
      const config = this.context.config;

      try {
        const body: any = {
          number: config.botPhone,
          message: command.message || ''
        };

        if (command.groupId) {
          body.recipients = [command.groupId];
        } else if (command.recipient) {
          body.recipients = [command.recipient];
        }

        if (command.attachments) {
          body.base64_attachments = command.attachments;
        }

        if (command.mentions) {
          body.mentions = command.mentions;
        }

        if (command.quoteId && command.quoteAuthor) {
          body.quote_timestamp = command.quoteId;
          body.quote_author = command.quoteAuthor;
        }

        const response = await fetch(`${config.apiUrl}/v2/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        console.log('[SignalAfferent] Message sent');
      } catch (error: any) {
        console.error('[SignalAfferent] Failed to send message:', error);
        this.handleError('send', 'Failed to send message', error);
      }
    }

    private async listGroups(): Promise<void> {
      const config = this.context.config;

      try {
        const response = await fetch(
          `${config.apiUrl}/v1/groups/${encodeURIComponent(config.botPhone)}`
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const groups = await response.json();

        this.emit({
          topic: 'signal:groups-list',
          source: { elementId: this.id || 'signal', elementPath: [] },
          timestamp: Date.now(),
          payload: { groups }
        });
      } catch (error: any) {
        console.error('[SignalAfferent] Failed to list groups:', error);
        this.handleError('listGroups', 'Failed to list groups', error);
      }
    }

    private async listContacts(): Promise<void> {
      const config = this.context.config;

      try {
        const response = await fetch(
          `${config.apiUrl}/v1/contacts/${encodeURIComponent(config.botPhone)}`
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contacts = await response.json();

        this.emit({
          topic: 'signal:contacts-list',
          source: { elementId: this.id || 'signal', elementPath: [] },
          timestamp: Date.now(),
          payload: { contacts }
        });
      } catch (error: any) {
        console.error('[SignalAfferent] Failed to list contacts:', error);
        this.handleError('listContacts', 'Failed to list contacts', error);
      }
    }

    private async sendTypingIndicator(recipient?: string): Promise<void> {
      // Signal CLI doesn't have a direct typing indicator API
      // This is a placeholder for future implementation
      console.log('[SignalAfferent] Typing indicator not implemented');
    }

    async handleEvent(event: any): Promise<void> {
      // Handle control panel requests
      switch (event.topic) {
        case 'signal:request-groups':
          console.log('[SignalAfferent] Handling request-groups');
          await this.listGroups();
          break;

        case 'signal:request-contacts':
          console.log('[SignalAfferent] Handling request-contacts');
          await this.listContacts();
          break;

        case 'signal:send-message':
          console.log('[SignalAfferent] Handling send-message');
          await this.send({
            recipient: event.payload?.recipient,
            groupId: event.payload?.groupId,
            message: event.payload?.message
          });
          break;
      }
    }

    // Public API for action invocation

    static actions = {
      'listGroups': {
        description: 'List all Signal groups',
        parameters: {}
      },
      'listContacts': {
        description: 'List Signal contacts',
        parameters: {}
      },
      'send': {
        description: 'Send a message',
        parameters: {
          recipient: { type: 'string', required: false },
          groupId: { type: 'string', required: false },
          message: { type: 'string', required: true }
        }
      },
      'sendTyping': {
        description: 'Send typing indicator',
        parameters: {
          recipient: { type: 'string', required: false },
          groupId: { type: 'string', required: false }
        }
      }
    };

    async listGroupsAction(params: {}): Promise<void> {
      this.enqueueCommand({ type: 'listGroups' });
    }

    async listContactsAction(params: {}): Promise<void> {
      this.enqueueCommand({ type: 'listContacts' });
    }

    async send(params: { recipient?: string; groupId?: string; message: string }): Promise<void> {
      this.enqueueCommand({
        type: 'send',
        recipient: params.recipient,
        groupId: params.groupId,
        message: params.message
      });
    }

    async sendTyping(params: { recipient?: string; groupId?: string }): Promise<void> {
      this.enqueueCommand({
        type: 'sendTyping',
        recipient: params.recipient,
        groupId: params.groupId
      });
    }

    // Provide clean serialization for logging
    toJSON() {
      return {
        type: 'SignalAfferent',
        botPhone: this.currentBotPhone,
        botName: this.currentBotName,
        botUuid: this.currentBotUuid,
        connected: !!this.ws,
        reconnecting: !!this.reconnectTimeout,
        joinedGroups: this.joinedGroupsCache.length,
        groupNames: Object.keys(this.groupNamesCache).length
      };
    }
  }

  // Return components after class definition
  return {
    components: { SignalAfferent }
  };
}
