/**
 * SignalSubstreamRelayEffector - Relays speech facets from substreams
 * back to the originating Signal group/DM.
 *
 * When a bot-runtime enters a substream, it creates a stream
 * (ID prefix `substream:`) with a parentStreamId linking back to the
 * originating Signal stream. This effector:
 *
 * 1. Subscribes to ALL streams for speech facets
 * 2. Filters for facets whose streamId starts with `substream:`
 * 3. Resolves the parent stream -> Signal group/DM
 * 4. Sends formatted relay messages showing substream progress
 *
 * Message format:
 *   [substream:nanogpt-training] opus-4.6: <content truncated to ~500 chars>
 */

import axios from 'axios';
import { getSignalCliConfig } from '../config-loader.js';
import { convertGroupId } from '../utils/group-id-converter.js';
import type { SharedState, BotInstance } from '../types.js';

export interface SignalSubstreamRelayEffectorConfig {
  state: SharedState;
  maxRelayContentLength?: number;
  debounceWindowMs?: number;
}

/** Cached info about a substream's parent Signal destination (no bot phone — resolved per-speech) */
interface SubstreamParentInfo {
  parentStreamId: string;
  conversationType: string;
  groupId?: string;
  contactNumber?: string;
  contactUuid?: string;
  /** Bot phone embedded in DM stream IDs */
  dmBotPhone?: string;
}

export class SignalSubstreamRelayEffector {
  private state: SharedState;
  private maxRelayContentLength: number;
  private debounceWindowMs: number;
  private unsubscribe?: () => void;

  private failedLookups: Map<string, number> = new Map();

  private pendingSpeech: Map<string, {
    timer: ReturnType<typeof setTimeout>;
    content: string;
    agentName: string;
    substreamId: string;
  }> = new Map();

  constructor(config: SignalSubstreamRelayEffectorConfig) {
    this.state = config.state;
    this.maxRelayContentLength = config.maxRelayContentLength ?? 500;
    this.debounceWindowMs = config.debounceWindowMs ?? 1500;
  }

  setup(): void {
    const bot = this.getFirstBot();
    if (!bot) {
      console.warn('[SignalSubstreamRelay] No bots available yet, deferring setup');
      return;
    }

    this.unsubscribe = bot.grpcClient.subscribeToStreamDeltas(
      (facet) => this.handleFacet(facet),
      { streamIds: [] }
    );

    console.log('[SignalSubstreamRelay] Subscribed to all streams for substream relay');
  }

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    for (const [, pending] of this.pendingSpeech) {
      clearTimeout(pending.timer);
    }
    this.pendingSpeech.clear();
  }

  private handleFacet(facet: any): void {
    const streamId: string = facet.streamId || '';
    if (!streamId.startsWith('substream:')) return;

    if (facet.type === 'speech') {
      this.handleSubstreamSpeech(facet, streamId);
    }
  }

  private handleSubstreamSpeech(facet: any, substreamId: string): void {
    const content = facet.content || '';
    const attachments: any[] | undefined = facet.attachments?.length ? facet.attachments : undefined;
    if (!content && !attachments) return;

    // Skip relayed user messages (prevent feedback loops)
    if (facet.agentId === 'relay' || facet.state?.sourceStreamId) return;

    const agentName = facet.agentName || facet.agentId || 'unknown';
    const isCyclePending = facet.state?.cyclePending === true;

    // Attachments bypass debounce — send immediately (infrequent, need to arrive with speech)
    if (attachments) {
      const existing = this.pendingSpeech.get(substreamId);
      if (existing) {
        clearTimeout(existing.timer);
        this.pendingSpeech.delete(substreamId);
      }
      this.relaySpeech(substreamId, agentName, content, attachments);
      return;
    }

    if (isCyclePending) {
      const existing = this.pendingSpeech.get(substreamId);
      if (existing) clearTimeout(existing.timer);

      const timer = setTimeout(() => {
        this.pendingSpeech.delete(substreamId);
        this.relaySpeech(substreamId, agentName, content);
      }, this.debounceWindowMs);

      this.pendingSpeech.set(substreamId, { timer, content, agentName, substreamId });
    } else {
      const existing = this.pendingSpeech.get(substreamId);
      if (existing) {
        clearTimeout(existing.timer);
        this.pendingSpeech.delete(substreamId);
      }
      this.relaySpeech(substreamId, agentName, content);
    }
  }

  private async relaySpeech(
    substreamId: string,
    agentName: string,
    content: string,
    attachments?: any[]
  ): Promise<void> {
    const parentInfo = await this.resolveParentSignal(substreamId);
    if (!parentInfo) return;

    const cleaned = content.replace(/\n{3,}/g, '\n\n').trim();
    const truncated = cleaned.length > this.maxRelayContentLength
      ? cleaned.substring(0, this.maxRelayContentLength) + '...'
      : cleaned;

    const message = truncated ? `[${substreamId}] ${agentName}: ${truncated}` : '';

    // Convert attachments to base64 for Signal CLI API
    const base64Attachments: string[] = [];
    if (attachments?.length) {
      for (const att of attachments) {
        const b64 = att.data instanceof Uint8Array
          ? Buffer.from(att.data).toString('base64')
          : att.data;  // already base64
        base64Attachments.push(b64);
      }
    }

    // Use the speaking bot's phone — it's guaranteed to be in the group
    const botPhone = this.getBotPhoneByAgent(agentName) || parentInfo.dmBotPhone || this.getFirstBotPhone();
    if (!botPhone) {
      console.warn('[SignalSubstreamRelay] No bot phone available to send relay');
      return;
    }

    await this.sendToSignal(parentInfo, message, botPhone, base64Attachments);
  }

  private async resolveParentSignal(
    substreamId: string
  ): Promise<SubstreamParentInfo | null> {
    const failedAt = this.failedLookups.get(substreamId);
    if (failedAt && Date.now() - failedAt < 10_000) return null;

    const bot = this.getFirstBot();
    if (!bot) return null;

    try {
      const streamInfo = await bot.grpcClient.getStreamInfo(substreamId);
      if (!streamInfo || !streamInfo.parentId) {
        console.warn(`[SignalSubstreamRelay] No parent stream found for ${substreamId}`);
        this.failedLookups.set(substreamId, Date.now());
        return null;
      }

      const parentStreamId = streamInfo.parentId;
      const signalInfo = this.parseSignalStreamId(parentStreamId);
      if (!signalInfo) {
        this.failedLookups.set(substreamId, Date.now());
        return null;
      }

      const info: SubstreamParentInfo = { parentStreamId, ...signalInfo };
      console.log(`[SignalSubstreamRelay] Resolved ${substreamId} -> ${parentStreamId}`);
      return info;
    } catch (error: any) {
      console.error(`[SignalSubstreamRelay] Failed to resolve parent for ${substreamId}: ${error.message}`);
      this.failedLookups.set(substreamId, Date.now());
      return null;
    }
  }

  /**
   * Parse a Signal stream ID into its components.
   *   signal:group:<groupId>
   *   signal:dm:<botPhone>:<contact>
   */
  private parseSignalStreamId(streamId: string): Omit<SubstreamParentInfo, 'parentStreamId'> | null {
    if (!streamId.startsWith('signal:')) return null;

    const parts = streamId.split(':');
    if (parts[1] === 'group' && parts[2]) {
      return { conversationType: 'group', groupId: parts[2] };
    } else if (parts[1] === 'dm' && parts[2] && parts[3]) {
      return { conversationType: 'dm', dmBotPhone: parts[2], contactNumber: parts[3] };
    }

    return null;
  }

  private async sendToSignal(
    parentInfo: SubstreamParentInfo,
    content: string,
    botPhone: string,
    base64Attachments?: string[]
  ): Promise<void> {
    try {
      const { apiUrl } = getSignalCliConfig();

      const body: any = {
        number: botPhone,
        message: content,
        text_mode: 'styled',
      };

      if (base64Attachments?.length) {
        body.base64_attachments = base64Attachments;
      }

      if (parentInfo.conversationType === 'group' && parentInfo.groupId) {
        const externalGroupId = await convertGroupId(parentInfo.groupId, botPhone);
        body.recipients = [externalGroupId || parentInfo.groupId];
      } else if (parentInfo.contactNumber) {
        body.recipients = [parentInfo.contactNumber];
      } else {
        console.warn('[SignalSubstreamRelay] No recipient for relay');
        return;
      }

      await axios.post(`${apiUrl}/v2/send`, body, {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error: any) {
      console.error(`[SignalSubstreamRelay] Failed to send relay: ${error.message}`);
    }
  }

  /** Look up a bot's phone number by its agent name */
  private getBotPhoneByAgent(agentName: string): string | undefined {
    for (const [phone, bot] of this.state.bots) {
      if (bot.config.name === agentName || bot.config.agentName === agentName) {
        return phone;
      }
    }
    return undefined;
  }

  private getFirstBot(): BotInstance | null {
    for (const [, bot] of this.state.bots) {
      if (bot.grpcClient.isConnected()) return bot;
    }
    const first = this.state.bots.values().next();
    if (!first.done) return first.value;
    return null;
  }

  private getFirstBotPhone(): string | undefined {
    for (const [phone] of this.state.bots) {
      return phone;
    }
    return undefined;
  }
}
