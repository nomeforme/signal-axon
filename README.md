# Signal AXON

Signal messenger adapter for Connectome - bridges Signal CLI REST API to Connectome's VEIL state management.

## Overview

This AXON module enables Connectome-based digital minds to perceive and act through Signal messenger. It implements the MARTEM architecture:

- **SignalAfferent**: Async WebSocket connection to Signal CLI, emits events
- **SignalReceptor**: Converts Signal message events into VEIL facets
- **SignalEffector**: Sends agent speech facets as Signal messages
- **SignalActions**: Tool definitions for agent actions

## Architecture

```
Signal CLI REST API (WebSocket)
         ↓
  SignalAfferent (async, outside frame)
         ↓
  Events (signal:message, signal:receipt, etc.)
         ↓
  SignalReceptor (Phase 1: Events → Facets)
         ↓
  VEIL Facets (event, state, activation)
         ↓
  Agent Processing (via AgentEffector)
         ↓
  Speech Facets
         ↓
  SignalEffector (Phase 3: Facets → Signal API)
         ↓
  Signal CLI REST API (HTTP)
```

## Usage

From a Connectome host application:

```typescript
import { ConnectomeHost } from 'connectome-ts';
import { createSignalElement } from 'signal-axon';

const host = new ConnectomeHost({ /* ... */ });
await host.start();

// Load Signal AXON module
const signalElement = await createSignalElement(
  host.space,
  '+12345678900', // Bot phone number
  {
    signalApiUrl: 'http://localhost:8081',
    signalWsUrl: 'ws://localhost:8081'
  }
);

host.space.addChild(signalElement);
```

## Configuration

The module requires a running Signal CLI REST API instance. See the main repo's docker-compose.yml for setup.

## Features

- ✅ Direct messages
- ✅ Group chats
- ✅ Message receipts and read markers
- ✅ Image attachments
- ✅ Typing indicators
- ✅ Multi-bot support
- ✅ Privacy modes (opt-in/opt-out)
- ✅ Bot loop prevention

## Development

```bash
npm install
npm run build
npm run watch  # For development
```

## License

MIT
# signal-axon
