/**
 * Configuration loading for Signal AXON gRPC mode
 *
 * No static config.json — bot identities discovered from signal-cli.
 * Phone numbers from env vars or axon binding, names from signal-cli profile data,
 * UUIDs discovered via signal-cli REST API.
 */

import axios from 'axios';

/**
 * Parse bot phone numbers from environment
 */
export function getPhones(): string[] {
  const phonesEnv = process.env.BOT_PHONE_NUMBERS || '';
  const phones = phonesEnv.split(',').map(p => p.trim()).filter(p => p);

  if (phones.length === 0) {
    console.log('No BOT_PHONE_NUMBERS set — bots will arrive via axon binding');
  } else {
    console.log(`Found ${phones.length} phone(s) in BOT_PHONE_NUMBERS`);
  }

  return phones;
}

/**
 * Get gRPC server configuration from environment
 */
export function getGrpcConfig(): { host: string; port: number } {
  const grpcHost = process.env.CONNECTOME_GRPC_HOST || 'localhost:50051';
  const [host, portStr] = grpcHost.split(':');
  const port = parseInt(portStr) || 50051;
  return { host, port };
}

/**
 * Get Signal CLI configuration from environment
 */
export function getSignalCliConfig(): { wsUrl: string; apiUrl: string } {
  const wsUrl = process.env.SIGNAL_CLI_WS_URL || process.env.WS_BASE_URL || 'ws://localhost:8080';
  const apiUrl = process.env.SIGNAL_CLI_API_URL || process.env.HTTP_BASE_URL || 'http://localhost:8080';
  return { wsUrl, apiUrl };
}

/**
 * Parse operational config from environment with defaults
 */
export function getOperationalConfig(): {
  randomReplyChance: number;
  maxBotMentionsPerConversation: number;
  maxConversationFrames: number;
  maxMemoryFrames: number;
  maxMessageLength: number;
  groupPrivacyMode: 'opt-in' | 'opt-out';
} {
  const mode = process.env.GROUP_PRIVACY_MODE;
  return {
    randomReplyChance: parseInt(process.env.RANDOM_REPLY_CHANCE || '200') || 0,
    maxBotMentionsPerConversation: parseInt(process.env.MAX_BOT_MENTIONS || '1') || 1,
    maxConversationFrames: parseInt(process.env.MAX_CONVERSATION_FRAMES || '100') || 100,
    maxMemoryFrames: 500,
    // Default 0 = native (no aggressive split; Signal's "see more" handles long messages,
    // capped at Signal's 4096-char hard limit). Set MAX_MESSAGE_LENGTH=N for paragraph/
    // sentence/word-boundary chunking at N chars. Runtime-tunable via `!split` command.
    // NB: `|| 0` fallback intentional — allows env value "0" through (parseInt('0')||400=400 would be a bug).
    maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH || '0') || 0,
    groupPrivacyMode: (mode === 'opt-in' ? 'opt-in' : 'opt-out'),
  };
}

/**
 * Discover a bot's UUID via the signal-cli REST API.
 * Queries GET /v1/identities/{phone} and finds the self-identity entry.
 */
export async function discoverBotUuid(phone: string, apiUrl: string): Promise<string | undefined> {
  try {
    const response = await axios.get(
      `${apiUrl}/v1/identities/${encodeURIComponent(phone)}`,
      { timeout: 5000 }
    );
    const identities: any[] = response.data || [];
    const self = identities.find((id: any) => id.number === phone);
    if (self?.uuid) {
      return self.uuid;
    }
  } catch {
    // Endpoint not available or errored
  }
  return undefined;
}

/**
 * Discover UUIDs for multiple phones via signal-cli REST API.
 */
export async function discoverBotUuids(botPhones: string[], apiUrl: string): Promise<Map<string, string>> {
  const botUuids = new Map<string, string>();

  for (const phone of botPhones) {
    const uuid = await discoverBotUuid(phone, apiUrl);
    if (uuid) {
      botUuids.set(phone, uuid);
      console.log(`  ${phone}: UUID ${uuid}`);
    } else {
      console.warn(`  Warning: No UUID discovered for ${phone}`);
    }
  }

  return botUuids;
}

/**
 * Discover bot names for phone numbers.
 *
 * Attempts platform discovery via signal-cli REST API first.
 * Falls back to SIGNAL_BOT_NAMES env var (comma-separated, matching BOT_PHONE_NUMBERS by index).
 */
export async function discoverBotNames(
  phones: string[],
  apiUrl: string
): Promise<Map<string, string>> {
  const phoneToName = new Map<string, string>();

  // Try SIGNAL_BOT_NAMES env var first (explicit, reliable)
  const namesEnv = process.env.SIGNAL_BOT_NAMES || '';
  const envNames = namesEnv.split(',').map(n => n.trim()).filter(n => n);

  if (envNames.length > 0) {
    console.log('Discovering bot names from SIGNAL_BOT_NAMES env var...');
    for (let i = 0; i < Math.min(phones.length, envNames.length); i++) {
      phoneToName.set(phones[i], envNames[i]);
      console.log(`  ${phones[i]} → ${envNames[i]}`);
    }
    return phoneToName;
  }

  // Try signal-cli REST API profile discovery
  console.log('Discovering bot names from signal-cli API...');
  for (const phone of phones) {
    try {
      // Try fetching own profile via signal-cli REST API
      const response = await axios.get(
        `${apiUrl}/v1/profiles/${encodeURIComponent(phone)}`,
        { timeout: 5000 }
      );
      const profileName = response.data?.name || response.data?.profile_name;
      if (profileName) {
        phoneToName.set(phone, profileName);
        console.log(`  ${phone} → ${profileName} (from signal-cli profile)`);
        continue;
      }
    } catch {
      // Profile endpoint not available or doesn't return self-profile
    }

    try {
      // Try configuration endpoint
      const response = await axios.get(
        `${apiUrl}/v1/configuration/${encodeURIComponent(phone)}`,
        { timeout: 5000 }
      );
      const configName = response.data?.name || response.data?.profile_name;
      if (configName) {
        phoneToName.set(phone, configName);
        console.log(`  ${phone} → ${configName} (from signal-cli config)`);
        continue;
      }
    } catch {
      // Configuration endpoint not available
    }

    // No name discovered for this phone
    console.warn(`  ${phone}: Could not discover name from signal-cli API`);
  }

  // Check if we got all names
  const missing = phones.filter(p => !phoneToName.has(p));
  if (missing.length > 0) {
    console.error(`\nError: Could not discover names for ${missing.length} bot(s): ${missing.join(', ')}`);
    console.error('Set SIGNAL_BOT_NAMES env var (comma-separated, matching BOT_PHONE_NUMBERS by index)');
    process.exit(1);
  }

  return phoneToName;
}
