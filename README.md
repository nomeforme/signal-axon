# Signal AXON

Signal messenger client for Connectome gRPC microservices architecture.

## Overview

Signal AXON connects to Signal CLI and the Connectome gRPC server, enabling AI agents to communicate through Signal messenger. It handles:

- Receiving messages via Signal CLI WebSocket
- Sending responses via Signal CLI HTTP API
- Image attachment processing (download, compress, base64 encode)
- Multi-bot support with independent phone numbers
- Mention resolution (@username to Signal format)
- Text formatting (*bold*, _italic_, ~strikethrough~, \`monospace\`)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    DOCKER COMPOSE                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │  CONNECTOME-TS (gRPC Server :50051)                 │   │
│  │  • VEIL State Management                            │   │
│  │  • Context rendering                                │   │
│  │  • Facet storage                                    │   │
│  └───────────────────────┬─────────────────────────────┘   │
│                          │ gRPC                             │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  SIGNAL-AXON (gRPC Client)                          │   │
│  │  • SignalWebSocketReceptor (receive messages)       │   │
│  │  • SignalAgentEffector (run LLM, send responses)    │   │
│  │  • FocusedContextTransform (build LLM context)      │   │
│  │  • ToolLoopAgent (Anthropic/Bedrock with tools)     │   │
│  └───────────────────────┬─────────────────────────────┘   │
│                          │ WebSocket / HTTP                 │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  SIGNAL-CLI (REST API)                              │   │
│  │  • WebSocket: /v1/receive                           │   │
│  │  • HTTP: /v2/send                                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Signal CLI endpoints
SIGNAL_CLI_WS_URL=ws://signal-cli:8080/v1/receive
SIGNAL_CLI_API_URL=http://signal-cli:8080

# Bot phone numbers (comma-separated, match config.json order)
BOT_PHONE_NUMBERS=+12223334444,+15556667777

# Connectome gRPC server
CONNECTOME_GRPC_HOST=connectome:50051

# LLM Provider (choose one or both)
ANTHROPIC_API_KEY=sk-ant-api03-...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
```

### Bot Configuration (config.json)

```json
{
  "active_bots": ["bot-name-1", "bot-name-2"],
  "bots": {
    "bot-name-1": {
      "name": "bot-name-1",
      "phone": "+12223334444",
      "model": "claude-sonnet-4-20250514",
      "prompt": "You are a helpful assistant.",
      "max_tokens": 4096,
      "tools": ["fetch"]
    }
  }
}
```

### Model Naming

- **Anthropic API**: Use model IDs directly (e.g., `claude-sonnet-4-20250514`)
- **AWS Bedrock**: Prefix with `bedrock-` (e.g., `bedrock-claude-3-5-sonnet-20241022`)

## Running

### With Docker Compose

```bash
docker compose up signal-axon
```

### Development

```bash
npm install
npm run start:grpc
```

## Features

- **Multi-bot**: Multiple bots with different personalities/models
- **Image Processing**: Receives and processes image attachments
- **Tool Support**: Extensible tool system (fetch, etc.)
- **Mention Resolution**: Converts @username to Signal mentions
- **Text Formatting**: Supports Signal's markdown-style formatting
