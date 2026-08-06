/**
 * SignalSpeechEffector - Handles server-generated speech and actions
 *
 * Subscribes to speech and action facets from the Connectome server
 * and sends them to Signal:
 * - Speech facets → Signal messages
 *
 * Each managed bot delivers only its own speech. Unmanaged agents
 * (exogenous bots) handle their own platform delivery.
 */

import axios from 'axios';
import { cleanSpeechContent, splitMessage, detectAndConvertMentions, getNameToPhoneCache, convertGroupId } from '../utils/index.js';
import { getSignalCliConfig } from '../config-loader.js';
import type { StreamManager, StreamInfo } from '../stream-manager.js';
import type { SignalGrpcClient } from '../client.js';
import type { BotConfig, RuntimeConfig } from '../types.js';

/**
 * Signal's hard per-message length cap (4096 chars). When messageSplitThreshold
 * is 0 ("native" mode), we still pass this to splitMessage as the maxLength so
 * a runaway 8000-char message gets safely split into 2 instead of 400 — but
 * normal-length messages send as one chunk, letting Signal's built-in "see more"
 * handle the display.
 */
const SIGNAL_HARD_MESSAGE_LIMIT = 4096;

export interface SignalSpeechEffectorConfig {
  botConfig: BotConfig;
  streamManager: StreamManager;
  /** Set of bot names managed by this axon (discovered on startup) */
  managedBotNames: Set<string>;
  /**
   * Shared runtime config — read live each speech delivery so `!split` updates
   * take effect immediately without restarting the axon.
   */
  runtimeConfig: RuntimeConfig;
  /** gRPC client — used to resolve content-addressed attachment blob refs. */
  grpcClient: SignalGrpcClient;
}

/**
 * SignalSpeechEffector - Sends server-generated speech to Signal
 *
 * Constraint equivalent: EFFECTOR priority (produces side effects)
 */
export class SignalSpeechEffector {
  private botConfig: BotConfig;
  private streamManager: StreamManager;
  private managedBotNames: Set<string>;
  private runtimeConfig: RuntimeConfig;
  private grpcClient: SignalGrpcClient;

  constructor(config: SignalSpeechEffectorConfig) {
    this.botConfig = config.botConfig;
    this.streamManager = config.streamManager;
    this.managedBotNames = config.managedBotNames;
    this.runtimeConfig = config.runtimeConfig;
    this.grpcClient = config.grpcClient;
  }

  /**
   * Get bot name
   */
  getName(): string {
    return this.botConfig.name;
  }

  /**
   * Set up subscriptions to server facets
   */
  setup(): void {
    this.setupSpeechHandler();
    console.log(`[SignalSpeechEffector:${this.botConfig.name}] Handlers registered`);
  }

  /**
   * Set up speech handler (handles server-generated speech)
   */
  private setupSpeechHandler(): void {
    this.streamManager.onSpeech(async (facet, streamInfo) => {
      await this.handleSpeech(facet, streamInfo);
    });
  }

  /**
   * Handle speech facet from server
   *
   * Each managed bot delivers only its own speech.
   * If the speaker is another managed bot, that bot's effector handles it.
   * If the speaker is an unmanaged agent (exogenous), it has its own platform client.
   */
  private async handleSpeech(facet: any, streamInfo: StreamInfo): Promise<void> {
    const botName = this.botConfig.name;
    const botPhone = this.botConfig.phone!;

    // Determine speaker identity
    const speakerName = facet.agentName || facet.agentId || '';
    const agentName = this.botConfig.agentName;

    // Only deliver speech that matches THIS bot's name or agentName
    const isMyBot = speakerName === botName || facet.agentName === botName
      || (agentName && (speakerName === agentName || facet.agentName === agentName));
    if (!isMyBot) {
      return;
    }

    console.log(`[SignalSpeechEffector:${botName}] Sending message to ${streamInfo.groupName || streamInfo.contactNumber || streamInfo.streamId}`);

    try {
      // Clean speech content (strip XML tags, extract tool syntax)
      const cleanedContent = cleanSpeechContent(facet.content || '');
      if (!cleanedContent && !facet.attachments?.length) return;

      const { apiUrl } = getSignalCliConfig();

      // Detect @mentions and convert to Signal format (uses phone numbers for Signal CLI API)
      const { content: contentWithMentions, mentions } = detectAndConvertMentions(
        cleanedContent,
        getNameToPhoneCache()
      );

      // Build base64 attachments array from facet.
      //
      // Three possible transport modes per attachment:
      //  - blobId (preferred): pull bytes from the Connectome blob store via
      //    GetBlob, then base64-encode for signal-cli. Bytes never travelled
      //    through the FacetDelta broadcast — only the sha ref did.
      //  - data as Uint8Array: legacy inline path; convert to base64.
      //  - data as string: already base64.
      const base64Attachments: string[] = [];
      if (facet.attachments?.length) {
        for (const att of facet.attachments) {
          let b64: string | null = null;

          if (att.blobId) {
            try {
              const blob = await this.grpcClient.getBlob(att.blobId);
              b64 = Buffer.from(blob.bytes).toString('base64');
            } catch (err: any) {
              console.warn(`[SignalSpeechEffector:${botName}] Failed to resolve blob ${att.blobId.substring(0, 12)}...: ${err.message} — dropping attachment`);
              continue;
            }
          } else if (att.data instanceof Uint8Array) {
            b64 = Buffer.from(att.data).toString('base64');
          } else if (typeof att.data === 'string') {
            b64 = att.data;
          }

          if (b64) base64Attachments.push(b64);
        }
      }

      // Determine split threshold live: 0 = native mode (no aggressive splitting,
      // just cap at Signal's hard 4096 limit for safety on runaway messages).
      const threshold = this.runtimeConfig.messageSplitThreshold;
      const effectiveMax = threshold > 0 ? threshold : SIGNAL_HARD_MESSAGE_LIMIT;

      // Split if too long — ensure at least one chunk for attachment-only messages
      const chunks = contentWithMentions ? splitMessage(contentWithMentions, effectiveMax) : (base64Attachments.length > 0 ? [''] : []);

      // We collect the timestamps returned by signal-cli so we can register
      // `msg-signal-<botUuid>-<ts>` → speech-facet aliases with the server.
      // That lets a user react 🫥 to the bot's own message and have the
      // reaction handler locate the speech facet (which lives under
      // `speech-<eventId>`, not `msg-signal-*`, so the primary lookup would
      // otherwise miss). One send call → one timestamp → one alias.
      const sentTimestamps: number[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const body: any = {
          number: botPhone,
          message: chunk,
          text_mode: 'styled'  // Enable Signal text formatting
        };

        // Only include mentions in the first chunk
        if (i === 0 && mentions.length > 0) {
          body.mentions = mentions;
        }

        // Only include attachments in the first chunk
        if (i === 0 && base64Attachments.length > 0) {
          body.base64_attachments = base64Attachments;
        }

        // Determine recipient
        if (streamInfo.conversationType === 'group' && streamInfo.groupId) {
          // Convert internal group ID to external group ID for Signal CLI API
          const externalGroupId = await convertGroupId(streamInfo.groupId, botPhone);
          body.recipients = [externalGroupId || streamInfo.groupId];
        } else if (streamInfo.contactNumber) {
          body.recipients = [streamInfo.contactNumber];
        } else if (streamInfo.contactUuid) {
          body.recipients = [streamInfo.contactUuid];
        } else {
          console.warn(`[SignalSpeechEffector:${botName}] No recipient found for stream ${streamInfo.streamId}`);
          return;
        }

        // Send with one delayed retry: Signal rate-limits bursty accounts
        // server-side (observed: bare HTTP 400 after ~12s following a rapid
        // message run). Without a retry the speech is silently dropped while
        // VEIL records it — bots "see" a message humans never received.
        let resp;
        try {
          resp = await axios.post(`${apiUrl}/v2/send`, body, {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (sendErr: any) {
          const status = sendErr?.response?.status;
          const detail = JSON.stringify(sendErr?.response?.data ?? sendErr?.message ?? '').slice(0, 300);
          console.warn(`[SignalSpeechEffector:${botName}] Send failed (HTTP ${status}): ${detail} — retrying in 10s`);
          await new Promise(r => setTimeout(r, 10_000));
          resp = await axios.post(`${apiUrl}/v2/send`, body, {
            headers: { 'Content-Type': 'application/json' }
          });
          console.log(`[SignalSpeechEffector:${botName}] Retry succeeded`);
        }
        // Response shape varies by signal-cli-rest version. Observed:
        //   v0.85+ direct send    → { timestamp: "<ms-as-string>" }  (yes, STRING)
        //   older / multi-recip.  → { results: [{ timestamp: ... }] }
        // Coerce to number defensively regardless of shape.
        const data: any = resp?.data;
        const raw = data?.timestamp
          ?? (Array.isArray(data?.results) ? data.results[0]?.timestamp : undefined)
          ?? (Array.isArray(data) ? data[0]?.timestamp : undefined);
        const ts = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
        if (Number.isFinite(ts)) sentTimestamps.push(ts);
      }

      console.log(`[SignalSpeechEffector:${botName}] Sent ${chunks.length} chunk(s)`);

      // Register redaction aliases. Only possible when we know this bot's own
      // UUID (populated at signal-cli discovery time — see grpc-main.ts
      // `discoverBotUuid`). Fire-and-forget.
      const botUuid = this.botConfig.uuid;
      if (facet?.id && botUuid && sentTimestamps.length) {
        for (const ts of sentTimestamps) {
          this.grpcClient.emitEvent('agent:speech:delivered', {
            facetId: facet.id,
            platform: 'signal',
            senderUuid: botUuid,
            timestamp: ts,
          }, { priority: 'low', waitForFrame: false }).catch((err: any) => {
            console.warn(`[SignalSpeechEffector:${botName}] Failed to register speech alias ${ts}: ${err.message}`);
          });
        }
      }
    } catch (error: any) {
      console.error(`[SignalSpeechEffector:${botName}] Error sending message:`, error.message);
    }
  }
}
