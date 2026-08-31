/**
 * SignalMessageReceptor - gRPC equivalent of the non-gRPC SignalMessageReceptor
 *
 * Handles Signal message events and routes them appropriately:
 * - Emits messages to Connectome server as facets
 * - Routes mentions/replies to appropriate bots
 * - Handles bot-to-bot interaction limits
 * - Triggers agent activation for relevant messages
 *
 * This is the gRPC client-side equivalent - it doesn't extend Component
 * since it runs in the client, not the server's Space.
 */

import { messageDeduplicator } from '../../message-deduplicator.js';
import { replaceMentionPlaceholders, getNameToUuidCache } from '../utils/mention-resolver.js';
import type { BotInstance, SharedState, RuntimeConfig, SignalMessageEvent } from '../types.js';
import type { SignalCommandEffector } from './signal-command-effector.js';

export interface SignalMessageReceptorConfig {
  bot: BotInstance;
  state: SharedState;
  commandEffector: SignalCommandEffector;
  updateConfig: (updates: Partial<RuntimeConfig>) => void;
}

/**
 * SignalMessageReceptor - Processes Signal messages into Connectome facets
 *
 * Constraint equivalent: RECEPTOR priority (runs early to transform events to facets)
 */
export class SignalMessageReceptor {
  private bot: BotInstance;
  private state: SharedState;
  private commandEffector: SignalCommandEffector;
  private updateConfig: (updates: Partial<RuntimeConfig>) => void;

  // Per-bot deduplication for messages targeted at this bot
  // Prevents double-processing when WebSocket reconnects and re-receives messages
  private processedMessages = new Map<string, number>();
  private readonly PROCESSED_TTL = 30000; // 30 seconds
  private lastCleanup = Date.now();

  constructor(config: SignalMessageReceptorConfig) {
    this.bot = config.bot;
    this.state = config.state;
    this.commandEffector = config.commandEffector;
    this.updateConfig = config.updateConfig;
  }

  /**
   * Check if this bot has already processed this message
   */
  private hasProcessed(messageId: string): boolean {
    // Periodic cleanup
    const now = Date.now();
    if (now - this.lastCleanup > 10000) {
      this.lastCleanup = now;
      const cutoff = now - this.PROCESSED_TTL;
      for (const [id, timestamp] of this.processedMessages) {
        if (timestamp < cutoff) {
          this.processedMessages.delete(id);
        }
      }
    }

    return this.processedMessages.has(messageId);
  }

  /**
   * Mark a message as processed by this bot
   */
  private markProcessed(messageId: string): void {
    this.processedMessages.set(messageId, Date.now());
  }

  /**
   * Get this bot's UUID by reverse lookup from botUuidToName
   */
  private getBotUuid(): string | undefined {
    const botName = this.bot.config.name;
    for (const [uuid, name] of this.state.botUuidToName) {
      if (name === botName) {
        return uuid;
      }
    }
    return undefined;
  }

  /**
   * Handle incoming Signal message
   * Called by SignalWebSocketReceptor when a message is received
   *
   * Flow:
   * 1. Handle privacy mode (opt-in/opt-out) with `.` prefix
   * 2. Emit messages to Connectome based on privacy mode rules
   * 3. Check if should activate agent (bot mentioned/quoted)
   * 4. Check for self-mention (bot should not respond to itself)
   * 5. If yes, run agent
   */
  async handleMessage(event: SignalMessageEvent): Promise<void> {
    const botName = this.bot.config.name;
    const botPhone = this.bot.config.phone!;
    const botUuid = this.getBotUuid();

    // Build stream ID for tracking
    // For DMs: include bot phone to isolate each bot's conversation with a user
    // For groups: just use group ID (all bots share same group context)
    const streamId = event.groupId
      ? `signal:group:${event.groupId}`
      : `signal:dm:${botPhone}:${event.senderNumber || event.senderUuid}`;

    const isGroupMessage = !!event.groupId;
    const groupPrivacyMode = this.state.runtimeConfig.groupPrivacyMode;

    // Check if this bot was mentioned
    const botMentioned = this.isBotMentioned(event.mentions, botName);
    // Check if this bot was quoted
    const quotedBotName = this.findQuotedBot(event.quotedMessage);
    const quotedBot = quotedBotName === botName;

    // Debug logging for mention detection (only log once per message via dedup check)
    if (event.mentions?.length && !this.state.bots.has(event.senderNumber || '')) {
      const resolvedMentions = event.mentions.map(m => {
        const resolved = this.state.botUuidToName.get(m.uuid);
        return `${m.uuid.substring(0, 8)}...→${resolved || 'UNKNOWN'}`;
      });
      console.log(`[SignalMessageReceptor:${botName}] Mentions: [${resolvedMentions.join(', ')}] botMentioned=${botMentioned} (botUuid=${botUuid?.substring(0, 8) || 'none'})`);
    }

    // Debug logging for quote detection
    if (event.quotedMessage) {
      console.log(`[SignalMessageReceptor:${botName}] Quote detected - authorUuid: ${event.quotedMessage.authorUuid}, resolved to: ${quotedBotName || 'unknown'}, isMe: ${quotedBot}`);
    }

    // ============================================================
    // STEP 1: Handle privacy mode for group messages
    // ============================================================
    let processedContent = event.content || '';
    let shouldEmitToConnectome = true;

    if (isGroupMessage) {
      const hasDotPrefix = processedContent.startsWith('.');

      if (groupPrivacyMode === 'opt-in') {
        // Opt-in: Only store/process messages with "." prefix OR when bot is mentioned/quoted
        if (!hasDotPrefix && !botMentioned && !quotedBot) {
          // Message doesn't qualify for storage in opt-in mode
          shouldEmitToConnectome = false;
          console.log(`[SignalMessageReceptor:${botName}] Opt-in mode: Skipping message (no prefix, not mentioned)`);
        }
        // Remove "." prefix if present for processing
        if (hasDotPrefix) {
          processedContent = processedContent.substring(1).trim();
        }
      } else {
        // Opt-out (default): Store ALL messages UNLESS prefixed with "."
        if (hasDotPrefix) {
          // User explicitly opted out - don't store or respond
          console.log(`[SignalMessageReceptor:${botName}] Opt-out mode: Skipping message with '.' prefix`);
          return;
        }
      }
    }

    // Cache sender UUID → name for mention resolution (covers non-bot users too)
    // Uses uuidToName (general map), NOT botUuidToName (bot-only, used for isSenderBot check)
    if (event.senderUuid && event.sender) {
      this.state.uuidToName.set(event.senderUuid, event.sender);
    }

    // Replace mention placeholders with @name for readable content
    // Use uuidToName (has both bots and humans) for broadest resolution
    const readableContent = replaceMentionPlaceholders(
      processedContent,
      event.mentions,
      this.state.uuidToName
    );

    // Build message ID for deduplication
    const messageId = `${event.senderUuid || event.sender}-${event.timestamp}`;

    // Check if sender is a bot
    const isSenderBot = this.state.botUuidToName.has(event.senderUuid || '');

    // ============================================================
    // STEP 2: Emit messages to Connectome (based on privacy mode and deduplication)
    // ============================================================
    // For group messages, use deduplicator to ensure only one bot emits
    // For DMs, each bot handles their own stream so no deduplication needed
    //
    // SPECIAL CASE: If message has attachments AND targets specific bot(s) (mention/quote),
    // the first targeted bot (alphabetically) gets emission priority instead of dedup lottery.
    // This ensures the targeted bot has attachments in context when it activates.

    // Check if message has image attachments
    const hasImageAttachments = event.attachments?.some(
      att => att.contentType?.startsWith('image/')
    ) ?? false;

    // Find all targeted bots (mentioned + quoted)
    const targetedBotNames: string[] = [];
    if (event.mentions) {
      for (const mention of event.mentions) {
        const name = this.state.botUuidToName.get(mention.uuid);
        if (name && !targetedBotNames.includes(name)) {
          targetedBotNames.push(name);
        }
      }
    }
    if (event.quotedMessage?.authorUuid) {
      const quotedName = this.state.botUuidToName.get(event.quotedMessage.authorUuid);
      if (quotedName && !targetedBotNames.includes(quotedName)) {
        targetedBotNames.push(quotedName);
      }
    }

    // ============================================================
    // STEP 2a: ! commands — handled by command effectors, NEVER stored in
    // VEIL (parity with Discord). This must run BEFORE emission: previously
    // the emit-winning bot stored the command text as a message facet (and
    // logged a spurious activation) before the command check returned early.
    // Gating: targeted commands (@bot !cmd / quote) are handled only by the
    // targeted bot; untargeted group commands go through the dedup lottery so
    // exactly one bot handles them (this also makes bare stream-wide commands
    // like `!mcf 400` work in groups — they previously required a mention).
    // ============================================================
    const strippedForCommand = readableContent.replace(/^(@\S+\s+)+/, '').trim();
    const isContinuationCommand =
      /^[!]continue\b/i.test(strippedForCommand) || /^m\s+(continue|go|more)\b/i.test(strippedForCommand);
    const earlyCommandText = this.parseCommand(readableContent);
    if (!isSenderBot && (isContinuationCommand || earlyCommandText)) {
      if (targetedBotNames.length > 0) {
        if (!targetedBotNames.includes(botName)) {
          return; // A bot was targeted and it isn't this one — nobody emits commands
        }
      } else if (isGroupMessage) {
        const cmdKey = `cmd-${event.sender}-${event.timestamp}`;
        if (!messageDeduplicator.shouldEmit(cmdKey, botPhone, isGroupMessage)) {
          return; // Another bot won the lottery for this untargeted command
        }
      }

      if (isContinuationCommand) {
        console.log(`[SignalMessageReceptor:${botName}] Continuation command detected`);
        // Activate the agent with continuation flag — skip normal message flow
        // (Signal doesn't support message deletion, so the trigger stays out of
        // VEIL by virtue of this early return instead)
        try {
          await this.bot.grpcClient.activateAgent(streamId, 'continuation', {
            messageContent: '',
            authorName: event.sender,
            streamType: 'signal',
            targetBot: botName,
            continuation: 'true',
            ...this.mcfMetadata(streamId, botName),
          });
          console.log(`[SignalMessageReceptor:${botName}] Continuation activation sent for stream ${streamId}`);
        } catch (error: any) {
          console.error(`[SignalMessageReceptor:${botName}] Error sending continuation activation:`, error.message);
        }
        return;
      }

      // For !sysprompt, pre-resolve the first text/* attachment to a UTF-8
      // string so the effector can install it without needing a gRPC client.
      let sysPromptFileText: string | undefined;
      if (earlyCommandText!.toLowerCase().startsWith('!sysprompt') && event.attachments && event.attachments.length > 0) {
        sysPromptFileText = await this.resolveSysPromptAttachment(event.attachments);
      }

      const response = this.commandEffector.handleCommand(
        earlyCommandText!,
        this.state.runtimeConfig,
        this.updateConfig,
        (topic, payload) => this.bot.grpcClient.emitEvent(topic, { ...payload, streamId }),
        sysPromptFileText,
        streamId,
        targetedBotNames.includes(botName),
      );
      if (response) {
        try {
          await this.sendSignalMessage(response, event);
          console.log(`[SignalMessageReceptor:${botName}] Handled command: ${earlyCommandText!.substring(0, 30)}...`);
        } catch (error: any) {
          console.error(`[SignalMessageReceptor:${botName}] Error sending command response:`, error.message);
        }
      }
      // Recognized or not, `!`-prefixed text is command-namespace — never
      // emitted to VEIL and never activates an agent.
      return;
    }

    // Determine priority emitter for attachment+targeted case
    let priorityEmitter: string | null = null;
    if (hasImageAttachments && targetedBotNames.length > 0) {
      // Sort alphabetically and pick first
      targetedBotNames.sort();
      priorityEmitter = targetedBotNames[0];
      console.log(`[SignalMessageReceptor:${botName}] Message has image + targets: [${targetedBotNames.join(', ')}], priority emitter: ${priorityEmitter}`);
    }

    // Track if this bot should skip activation due to not being priority emitter
    let skipActivationForPriority = false;

    if (isGroupMessage && shouldEmitToConnectome) {
      if (priorityEmitter) {
        // Attachment + targeted case: only priority emitter emits (image
        // processing is expensive, and every targeted bot activating with the
        // image would compress/upload it N times).
        if (botName !== priorityEmitter) {
          shouldEmitToConnectome = false;
          // If this bot IS targeted but not priority emitter, skip activation too
          if (targetedBotNames.includes(botName)) {
            skipActivationForPriority = true;
            console.log(`[SignalMessageReceptor:${botName}] Skipping (targeted but not priority emitter, ${priorityEmitter} will handle)`);
          } else {
            console.log(`[SignalMessageReceptor:${botName}] Not priority emitter, ${priorityEmitter} will emit`);
          }
        } else {
          console.log(`[SignalMessageReceptor:${botName}] I am priority emitter for attachment message`);
        }
      } else if (targetedBotNames.length > 0) {
        // Targeted (non-image) case: every targeted bot emits its own copy.
        // Server dedupes on the deterministic facet ID
        // (`msg-signal-<senderId>-<timestamp>`) — first emit creates the frame,
        // subsequent emits no-op server-side but still receive `waitForFrame`
        // acknowledgment.
        //
        // Why: previously non-emit-winning targeted bots called `activateAgent`
        // immediately, racing the winner's `emitSignalMessage`. If the
        // activation reached the server before the message facet landed, the
        // rendered context omitted the trigger — the bot then saw an activation
        // with no visible new message. Every targeted bot doing its own emit
        // turns the race into a per-bot sequential barrier.
        if (!targetedBotNames.includes(botName)) {
          shouldEmitToConnectome = false;
          console.log(`[SignalMessageReceptor:${botName}] Not targeted, ${targetedBotNames.join('/')} will emit`);
        }
      } else {
        // Untargeted (random-reply / passive) case: fall back to lottery.
        const dedupeKey = `emit-${event.sender}-${event.timestamp}-${event.content?.substring(0, 50)}`;
        if (!messageDeduplicator.shouldEmit(dedupeKey, botPhone, isGroupMessage)) {
          shouldEmitToConnectome = false;
          console.log(`[SignalMessageReceptor:${botName}] Another bot will emit this message to Connectome`);
        }
      }
    }

    // Don't emit bot messages to Connectome - they're already recorded via agent:speech
    // This prevents duplicate facets (signal:message + agent:speech for same content)
    if (isSenderBot && shouldEmitToConnectome) {
      shouldEmitToConnectome = false;
      console.log(`[SignalMessageReceptor:${botName}] Skipping bot message emission (recorded via agent:speech)`);
    }

    if (shouldEmitToConnectome) {
      try {
        // Ensure stream exists on server
        await this.bot.streamManager.getOrCreateStream(
          event.groupId || event.senderNumber || event.senderUuid || 'unknown',
          {
            conversationType: event.groupId ? 'group' : 'dm',
            groupId: event.groupId,
            groupName: event.groupName,
            contactNumber: event.senderNumber,
            contactUuid: event.senderUuid,
            botPhone
          }
        );

        // Upload inline attachment bytes to the content-addressed blob store
        // BEFORE emitting the signal:message event. Only the lottery-winning
        // bot reaches this point per message, so each unique image hits PutBlob
        // exactly once (and dedup makes re-uploads of the same sha free anyway).
        // The emit payload then carries refs instead of bytes, so the subsequent
        // fan-out broadcast across all subscribers stays metadata-only.
        const uploadedAttachments = await this.uploadAttachmentsToBlobStore(event.attachments, botName);

        // Emit message to Connectome (creates facet in VEIL for context)
        await this.bot.grpcClient.emitSignalMessage({
          content: readableContent,
          sender: event.sender,
          senderNumber: event.senderNumber,
          senderUuid: event.senderUuid,
          groupId: event.groupId,
          groupName: event.groupName,
          botPhone,
          timestamp: event.timestamp,
          attachments: uploadedAttachments,
          mentions: event.mentions,
          quotedMessage: event.quotedMessage
        });

        console.log(`[SignalMessageReceptor:${botName}] Emitted message to Connectome: ${readableContent.substring(0, 50)}...`);
      } catch (error: any) {
        console.error(`[SignalMessageReceptor:${botName}] Error emitting to Connectome:`, error.message);
      }
    }

    // ============================================================
    // STEP 3: Check for self-mention (bot should not respond to itself)
    // ============================================================
    const isSelfMention = botUuid && event.senderUuid === botUuid;
    if (isSelfMention) {
      console.log(`[SignalMessageReceptor:${botName}] Ignoring self-mention (sender is this bot)`);
      // Message was already emitted to Connectome for context, but don't activate agent
      return;
    }

    // ============================================================
    // STEP 4: Determine if agent should be activated
    // ============================================================
    // We already computed botMentioned and quotedBot earlier for privacy mode
    const mentionedBotName = this.findMentionedBot(event.mentions);
    const replyToBotName = this.findQuotedBot(event.quotedMessage);

    let shouldActivate = false;
    let activationReason = '';

    // Defensive guard: never activate on an empty message with no attachments.
    // Contentless artifacts (reactions, receipts, sync/profile updates) should
    // already be filtered upstream in the websocket receptor, but this ensures
    // no path — especially the unconditional DM branch below — can fire an
    // unsolicited "your message came through empty" reply.
    const hasActionableContent =
      !!readableContent.trim() || (event.attachments?.length ?? 0) > 0;
    if (!hasActionableContent) {
      console.log(`[SignalMessageReceptor:${botName}] Skipping activation: empty message, no attachments (likely reaction/receipt/sync)`);
      return;
    }

    if (botMentioned) {
      // This bot was mentioned - activate
      if (this.hasProcessed(messageId)) {
        console.log(`[SignalMessageReceptor:${botName}] Already processed message ${messageId.substring(0, 30)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'mention';
    } else if (quotedBot) {
      // This bot was quoted - activate
      if (this.hasProcessed(messageId)) {
        console.log(`[SignalMessageReceptor:${botName}] Already processed message ${messageId.substring(0, 30)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'quote';
    } else if (!isGroupMessage) {
      // DM - this bot should respond
      if (this.hasProcessed(messageId)) {
        console.log(`[SignalMessageReceptor:${botName}] Already processed DM ${messageId.substring(0, 30)}...`);
        return;
      }
      shouldActivate = true;
      activationReason = 'dm';
    }

    // Random reply check - applies to ALL group messages where this bot wasn't directly targeted
    // This includes messages that mention OTHER bots (they can still trigger random reply)
    if (!shouldActivate && isGroupMessage) {
      const randomChance = this.state.runtimeConfig.randomReplyChance;
      if (randomChance > 0 && !isSenderBot) {
        const roll = Math.floor(Math.random() * randomChance) + 1;
        const shouldRandomReply = roll === 1;
        console.log(`[SignalMessageReceptor:${botName}] Random roll: ${roll}/${randomChance} (trigger=${shouldRandomReply})`);
        if (shouldRandomReply) {
          shouldActivate = true;
          activationReason = 'random';
        }
      } else if (randomChance === 0) {
        console.log(`[SignalMessageReceptor:${botName}] Random reply disabled (chance=0)`);
      }
    }

    // If not activating, we're done (message was already emitted to Connectome)
    if (!shouldActivate) {
      return;
    }

    // Skip activation if this bot was targeted but not the priority emitter
    // (The priority emitter will handle both emit and activation)
    if (skipActivationForPriority) {
      return;
    }

    // Log activation
    console.log(`[SignalMessageReceptor:${botName}] Activating for message from ${event.sender}: ${readableContent.substring(0, 50)}... (${activationReason})`);

    // NOTE: !continue and ! commands are handled in STEP 2a (pre-emission)
    // so they never reach VEIL — see above.

    // Mark this message as processed by this bot
    this.markProcessed(messageId);

    // ============================================================
    // STEP 5: Bot-to-bot limiting and agent activation
    // ============================================================
    if (isSenderBot) {
      const currentCount = this.state.botInteractionCounts.get(streamId) || 0;
      const maxBotMentions = this.state.runtimeConfig.maxBotMentionsPerConversation;

      if (maxBotMentions > 0 && currentCount >= maxBotMentions) {
        console.log(`[SignalMessageReceptor:${botName}] Bot-to-bot limit reached (${currentCount}/${maxBotMentions}), skipping agent`);
        return;
      }

      this.state.botInteractionCounts.set(streamId, currentCount + 1);
      console.log(`[SignalMessageReceptor:${botName}] Bot-to-bot interaction ${currentCount + 1}/${maxBotMentions}`);
    } else {
      // Human message - reset counter
      if (this.state.botInteractionCounts.has(streamId)) {
        this.state.botInteractionCounts.set(streamId, 0);
        console.log(`[SignalMessageReceptor:${botName}] Human message - reset bot-to-bot counter`);
      }
    }

    // Trigger remote agent activation via gRPC
    try {
      // Guard: skip if gRPC client lost connection
      if (!this.bot.grpcClient.isConnected()) {
        console.warn(`[SignalMessageReceptor:${botName}] gRPC client not connected, skipping activation`);
        return;
      }

      // Ensure this bot's stream manager is subscribed so its
      // speech effector receives the reply (the emit lottery winner may be a different bot)
      const botPhone = this.bot.config.phone!;
      await this.bot.streamManager.getOrCreateStream(
        event.groupId || event.senderNumber || event.senderUuid || 'unknown',
        {
          conversationType: event.groupId ? 'group' : 'dm',
          groupId: event.groupId,
          groupName: event.groupName,
          contactNumber: event.senderNumber,
          contactUuid: event.senderUuid,
          botPhone
        }
      );

      // Trigger server-side activation via gRPC
      await this.bot.grpcClient.activateAgent(streamId, activationReason, {
        messageContent: readableContent,
        authorName: event.sender,
        streamType: 'signal',
        targetBot: botName,
        ...this.mcfMetadata(streamId, botName),
      });
      console.log(`[SignalMessageReceptor:${botName}] Remote activation sent for stream ${streamId}`);
    } catch (error: any) {
      console.error(`[SignalMessageReceptor:${botName}] Error activating agent:`, error.message);
    }
  }

  /**
   * Resolve a `!mcf` override for this bot on this stream and shape it as
   * activation metadata. Bot-specific entry wins over the stream-wide '*'
   * entry; no entry → empty object (server default applies).
   */
  private mcfMetadata(streamId: string, botName: string): Record<string, string> {
    const per = this.state.runtimeConfig.mcfStreamOverrides?.[streamId];
    // Precedence: per-stream bot-specific !mcf → per-stream '*' !mcf →
    // per-bot default advertised by bot-runtime (config.json
    // max_context_frames) → server env default (no metadata sent).
    const value = per?.[botName] ?? per?.['*'] ?? this.bot.config.defaultMaxContextFrames;
    return value !== undefined ? { maxContextFrames: String(value) } : {};
  }

  /**
   * Resolve the first text/* attachment to a UTF-8 string for `!sysprompt file`.
   *
   * Handles both transport modes:
   *  - inline `data` (base64 from the WS receptor)
   *  - `blobId` ref (pulled via ConnectomeClient.getBlob)
   *
   * Returns undefined if no suitable attachment is present or resolution
   * fails. Never throws — sysprompt is best-effort UX.
   */
  private async resolveSysPromptAttachment(
    attachments: NonNullable<SignalMessageEvent['attachments']>,
  ): Promise<string | undefined> {
    const MAX_TEXT_BYTES = 64 * 1024;
    const botName = this.bot.config.name;

    for (const att of attachments) {
      const ct = (att.contentType || '').toLowerCase();
      const nameLower = (att.filename || '').toLowerCase();
      const isText =
        ct.startsWith('text/') ||
        /\.(txt|md|markdown|prompt)$/i.test(nameLower);
      if (!isText) continue;
      const declaredSize = att.size ?? 0;
      if (declaredSize > MAX_TEXT_BYTES) {
        console.warn(
          `[SignalMessageReceptor:${botName}] Skipping sysprompt attachment ${att.filename}: ${declaredSize} bytes > ${MAX_TEXT_BYTES} limit`,
        );
        continue;
      }

      try {
        let bytes: Uint8Array | null = null;
        if (att.data) {
          bytes = Uint8Array.from(Buffer.from(att.data, 'base64'));
        } else if (att.blobId) {
          const blob = await this.bot.grpcClient.getBlob(att.blobId);
          bytes = blob.bytes;
        }
        if (!bytes) continue;
        if (bytes.length > MAX_TEXT_BYTES) {
          console.warn(
            `[SignalMessageReceptor:${botName}] Sysprompt attachment resolved size ${bytes.length} > ${MAX_TEXT_BYTES} limit`,
          );
          continue;
        }
        const text = Buffer.from(bytes).toString('utf8');
        console.log(
          `[SignalMessageReceptor:${botName}] Resolved sysprompt attachment ${att.filename || '?'} (${text.length} chars)`,
        );
        return text;
      } catch (err: any) {
        console.warn(
          `[SignalMessageReceptor:${botName}] Sysprompt attachment resolution error: ${err.message}`,
        );
      }
    }
    return undefined;
  }

  /**
   * Replace inline attachment bytes with sha256 blob refs by uploading each
   * to the Connectome content-addressed store. Falls back to the original
   * inline shape on upload failure so the message still reaches the bot.
   *
   * Attachments lacking `data` (metadata-only, e.g. too-large or missing-id
   * cases from the websocket receptor) pass through unchanged.
   */
  private async uploadAttachmentsToBlobStore(
    attachments: SignalMessageEvent['attachments'],
    botName: string
  ): Promise<SignalMessageEvent['attachments']> {
    if (!attachments || attachments.length === 0) return attachments;

    const uploaded = await Promise.all(
      attachments.map(async (att) => {
        // Metadata-only or no inline payload — nothing to upload
        if (!att.data) return att;

        try {
          const bytes = Buffer.from(att.data, 'base64');
          const result = await this.bot.grpcClient.putBlob(new Uint8Array(bytes), {
            contentType: att.contentType || 'application/octet-stream',
            filename: att.filename,
          });
          if (result.alreadyExisted) {
            console.log(`[SignalMessageReceptor:${botName}] Blob ${result.blobId.substring(0, 12)}... already in store (dedup hit, ${bytes.length} bytes)`);
          } else {
            console.log(`[SignalMessageReceptor:${botName}] Uploaded blob ${result.blobId.substring(0, 12)}... (${bytes.length} bytes, ${att.contentType})`);
          }
          // Return ref-only attachment; bytes now live in the blob store.
          // `data` is omitted (so the JSON event payload is tiny).
          return {
            id: att.id,
            contentType: att.contentType,
            filename: att.filename,
            size: att.size ?? bytes.length,
            blobId: result.blobId,
          };
        } catch (err: any) {
          console.warn(`[SignalMessageReceptor:${botName}] Blob upload failed for ${att.filename || att.id}: ${err.message} — falling back to inline bytes`);
          return att;
        }
      })
    );

    return uploaded;
  }

  /**
   * Parse command from message text
   * Strips leading @mention if present, returns the command text or null if not a command
   *
   * Examples:
   * - "@botname !help" -> "!help"
   * - "!rr 5" -> "!rr 5"
   * - "hello" -> null
   */
  private parseCommand(message: string): string | null {
    if (!message) return null;

    let cleaned = message.trim();

    // Strip ALL leading @mentions (handles "@bot1 @bot2 !stream in piday")
    while (cleaned.startsWith('@')) {
      const spaceIndex = cleaned.indexOf(' ');
      if (spaceIndex > 0) {
        cleaned = cleaned.substring(spaceIndex + 1).trim();
      } else {
        // Just mentions with no content
        return null;
      }
    }

    // Check if it's a command
    if (!cleaned.startsWith('!')) return null;

    return cleaned;
  }

  /**
   * Find if any of our bots was mentioned
   */
  private findMentionedBot(mentions: SignalMessageEvent['mentions']): string | undefined {
    if (!mentions) return undefined;

    for (const mention of mentions) {
      const botName = this.state.botUuidToName.get(mention.uuid);
      if (botName) {
        return botName;
      }
    }

    return undefined;
  }

  /**
   * Check if THIS specific bot was mentioned
   */
  private isBotMentioned(mentions: SignalMessageEvent['mentions'], targetBotName: string): boolean {
    if (!mentions) return false;

    for (const mention of mentions) {
      const botName = this.state.botUuidToName.get(mention.uuid);
      if (botName === targetBotName) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find if quoted message was from one of our bots
   */
  private findQuotedBot(quote: SignalMessageEvent['quotedMessage']): string | undefined {
    if (!quote?.authorUuid) return undefined;

    return this.state.botUuidToName.get(quote.authorUuid);
  }

  /**
   * Send a message to Signal (for command responses)
   */
  private async sendSignalMessage(content: string, originalEvent: SignalMessageEvent): Promise<void> {
    const { getSignalCliConfig } = await import('../config-loader.js');
    const { convertGroupId } = await import('../utils/group-id-converter.js');
    const { default: axios } = await import('axios');
    const { apiUrl } = getSignalCliConfig();

    const body: any = {
      number: this.bot.config.phone,
      message: content,
      text_mode: 'styled'  // Enable Signal text formatting
    };

    if (originalEvent.groupId) {
      // Convert internal group ID to external group ID for Signal CLI API
      const externalGroupId = await convertGroupId(originalEvent.groupId, this.bot.config.phone!);
      body.recipients = [externalGroupId || originalEvent.groupId];
    } else {
      body.recipients = [originalEvent.senderNumber || originalEvent.senderUuid];
    }

    await axios.post(`${apiUrl}/v2/send`, body, {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
