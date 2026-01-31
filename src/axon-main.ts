#!/usr/bin/env npx tsx
/**
 * Signal AXON Module Server Entry Point
 *
 * Starts an AxonModuleServer to serve Signal-specific AXON modules.
 * These modules can be dynamically loaded by Connectome.
 *
 * This is separate from grpc-main.ts which runs the multi-bot gRPC client.
 * You can run both simultaneously if needed.
 *
 * Usage:
 *   npm run start:axon
 *   # or
 *   tsx src/axon-main.ts
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import express from 'express';
import { AxonModuleServer } from '@connectome/axon-server';
import { join } from 'path';

/**
 * Configuration from environment
 */
interface AxonServerConfig {
  port: number;
  hotReload: boolean;
  corsOrigin: string;
}

function loadConfig(): AxonServerConfig {
  return {
    port: parseInt(process.env.AXON_MODULE_PORT || '8082'),
    hotReload: process.env.NODE_ENV !== 'production',
    corsOrigin: process.env.CORS_ORIGIN || '*'
  };
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     SIGNAL AXON MODULE SERVER                          ║');
  console.log('║     Serves Signal components for dynamic loading       ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log();

  const config = loadConfig();

  console.log('Configuration:');
  console.log(`  Port:       ${config.port}`);
  console.log(`  Hot Reload: ${config.hotReload}`);
  console.log(`  CORS:       ${config.corsOrigin}`);
  console.log();

  // Create the module server
  const moduleServer = new AxonModuleServer({
    port: config.port,
    hotReload: config.hotReload,
    corsOrigin: config.corsOrigin
  });

  // Determine modules directory
  // In development: src/axon-modules
  // In production (compiled): dist/axon-modules -> need to use src still for TS files
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const isCompiledContext = __dirname.includes('dist');

  const modulesDir = isCompiledContext
    ? join(__dirname, '..', 'src', 'axon-modules')  // dist/ -> ../src/axon-modules
    : join(__dirname, 'axon-modules');              // src/ -> axon-modules

  console.log(`Module registration - isDev: ${isDevelopment}, modulesDir: ${modulesDir}`);

  // Register Signal Afferent module
  await moduleServer.addModule('signal-afferent', {
    name: 'signal-afferent',
    path: join(modulesDir, 'signal-afferent.ts'),
    manifest: {
      name: 'SignalAfferent',
      version: '1.0.0',
      description: 'Signal CLI WebSocket afferent for Connectome architecture',
      componentClass: 'SignalAfferent',
      moduleType: 'function',
      exports: {
        afferents: ['SignalAfferent']
      },
      actions: {
        'listGroups': {
          description: 'List all Signal groups',
          parameters: {}
        },
        'listContacts': {
          description: 'List Signal contacts',
          parameters: {}
        },
        'send': {
          description: 'Send a message to a group or contact',
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
      }
    }
  });
  console.log('✓ Registered signal-afferent module');

  // Register Signal Control Panel module
  await moduleServer.addModule('signal-control-panel', {
    name: 'signal-control-panel',
    path: join(modulesDir, 'signal-control-panel.ts'),
    manifest: {
      name: 'SignalControlPanelComponent',
      version: '1.0.0',
      description: 'Signal group and conversation management UI',
      componentClass: 'SignalControlPanelComponent',
      moduleType: 'function',
      actions: {
        'listGroups': {
          description: 'List all Signal groups',
          parameters: {}
        },
        'listContacts': {
          description: 'List Signal contacts',
          parameters: {}
        },
        'selectGroup': {
          description: 'Select a group for operations',
          parameters: {
            groupName: { type: 'string', required: true }
          }
        },
        'sendMessage': {
          description: 'Send a message to a group or contact',
          parameters: {
            message: { type: 'string', required: true },
            groupName: { type: 'string', required: false },
            contactNumber: { type: 'string', required: false }
          }
        },
        'showActiveConversations': {
          description: 'Show all active conversations',
          parameters: {}
        }
      }
    }
  });
  console.log('✓ Registered signal-control-panel module');

  // Handle shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[${signal}] Shutting down...`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start the server
  await moduleServer.startStandalone();

  console.log();
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  AXON Module Server listening on port ${config.port}`);
  console.log();
  console.log('  Available endpoints:');
  console.log(`    GET http://localhost:${config.port}/manifest`);
  console.log(`    GET http://localhost:${config.port}/signal-afferent/manifest`);
  console.log(`    GET http://localhost:${config.port}/signal-afferent/module`);
  console.log(`    GET http://localhost:${config.port}/signal-control-panel/manifest`);
  console.log(`    GET http://localhost:${config.port}/signal-control-panel/module`);
  console.log('═══════════════════════════════════════════════════════');
  console.log();
  console.log('Ready to serve modules. Press Ctrl+C to stop.');
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
