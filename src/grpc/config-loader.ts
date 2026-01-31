/**
 * Configuration loader for Signal AXON gRPC mode
 */

import fs from 'fs';
import path from 'path';
import type { SignalConfig, BotConfig } from './types.js';

/**
 * Load configuration from file
 */
export function loadConfig(): SignalConfig {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err: any) {
    console.error('Error loading config.json:', err.message);
    process.exit(1);
  }
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
 * Pair phone numbers with bot configurations by index
 */
export function pairPhonesWithBots(config: SignalConfig): BotConfig[] {
  const botPhoneNumbersEnv = process.env.BOT_PHONE_NUMBERS || '';
  const botPhones = botPhoneNumbersEnv.split(',').map(p => p.trim()).filter(p => p);

  if (botPhones.length === 0) {
    console.error('Error: BOT_PHONE_NUMBERS environment variable not set');
    return [];
  }

  const pairedBots: BotConfig[] = [];

  for (let i = 0; i < Math.min(botPhones.length, config.bots.length); i++) {
    const botConfig = config.bots[i];
    pairedBots.push({
      ...botConfig,
      phone: botPhones[i]
    });
    console.log(`  Paired: ${botConfig.name} → ${botPhones[i]}`);
  }

  return pairedBots;
}

/**
 * Load bot UUIDs from Signal CLI accounts.json
 */
export function loadBotUuids(
  botPhones: string[],
  botPhoneToName: Map<string, string>
): Map<string, string> {
  const botUuids = new Map<string, string>();
  const accountsPath = '/home/.local/share/signal-api/data/accounts.json';

  try {
    if (fs.existsSync(accountsPath)) {
      const accountsData = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
      const accounts = accountsData.accounts || [];

      for (const botPhone of botPhones) {
        const account = accounts.find((acc: any) => acc.number === botPhone);
        if (account?.uuid) {
          botUuids.set(botPhone, account.uuid);
          console.log(`  ${botPhoneToName.get(botPhone)} (${botPhone}): ${account.uuid}`);
        } else {
          console.warn(`  Warning: No UUID found for ${botPhoneToName.get(botPhone)} (${botPhone})`);
        }
      }
    } else {
      console.error(`accounts.json not found at ${accountsPath}`);
    }
  } catch (error) {
    console.error('Failed to load bot UUIDs:', error);
  }

  return botUuids;
}
