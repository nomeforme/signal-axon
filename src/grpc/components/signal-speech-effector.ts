/**
 * SignalSpeechEffector - Handles server-generated speech and actions
 *
 * Subscribes to speech and action facets from the Connectome server
 * and sends them to Signal:
 * - Speech facets → Signal messages
 *
 * This handles server-initiated output (vs SignalAgentEffector which
 * handles client-side agent execution).
 */

import axios from 'axios';
import { cleanSpeechContent, splitMessage, detectAndConvertMentions, getNameToPhoneCache, convertGroupId } from '../utils/index.js';
import { getSignalCliConfig } from '../config-loader.js';
import type { StreamManager, StreamInfo } from '../stream-manager.js';
import type { BotConfig } from '../types.js';

export interface SignalSpeechEffectorConfig {
  botConfig: BotConfig;
  streamManager: StreamManager;
  allBotNames: string[];
}

/**
 * SignalSpeechEffector - Sends server-generated speech to Signal
 *
 * Constraint equivalent: EFFECTOR priority (produces side effects)
 */
export class SignalSpeechEffector {
  private botConfig: BotConfig;
  private streamManager: StreamManager;
  private allBotNames: string[];

  constructor(config: SignalSpeechEffectorConfig) {
    this.botConfig = config.botConfig;
    this.streamManager = config.streamManager;
    this.allBotNames = config.allBotNames;
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
   */
  private async handleSpeech(facet: any, streamInfo: StreamInfo): Promise<void> {
    const botName = this.botConfig.name;
    const botPhone = this.botConfig.phone!;

    // Skip speech from any bot in our system - they all send directly to Signal
    const isFromOurBot = this.allBotNames.includes(facet.agentId || '') ||
                         this.allBotNames.includes(facet.agentName || '');
    if (isFromOurBot) {
      console.log(`[SignalSpeechEffector:${botName}] Skipping speech from our bot ${facet.agentName || facet.agentId}`);
      return;
    }

    console.log(`[SignalSpeechEffector:${botName}] Sending message to ${streamInfo.groupName || streamInfo.contactNumber || streamInfo.streamId}`);

    try {
      // Clean speech content (strip XML tags, extract tool syntax)
      const cleanedContent = cleanSpeechContent(facet.content || '');
      if (!cleanedContent) return;

      const { apiUrl } = getSignalCliConfig();

      // Detect @mentions and convert to Signal format (uses phone numbers for Signal CLI API)
      const { content: contentWithMentions, mentions } = detectAndConvertMentions(
        cleanedContent,
        getNameToPhoneCache()
      );

      // Split if too long
      const chunks = splitMessage(contentWithMentions);

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

        await axios.post(`${apiUrl}/v2/send`, body, {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log(`[SignalSpeechEffector:${botName}] Sent ${chunks.length} chunk(s)`);
    } catch (error: any) {
      console.error(`[SignalSpeechEffector:${botName}] Error sending message:`, error.message);
    }
  }
}
