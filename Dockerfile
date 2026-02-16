# Signal AXON Dockerfile
# gRPC client for Signal messenger integration
# Build context should be the parent /opt/connectome directory

FROM node:20-slim

# Install build dependencies for native modules (sharp)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace

# Copy all necessary packages (build context is parent directory)
COPY connectome-axon-interfaces ./connectome-axon-interfaces
COPY axon-server ./axon-server
COPY connectome-grpc-common ./connectome-grpc-common
COPY connectome-ts ./connectome-ts
COPY connectome-agent-core ./connectome-agent-core
COPY pi-mono ./pi-mono
COPY signal-axon ./signal-axon

# Build connectome-axon-interfaces
WORKDIR /workspace/connectome-axon-interfaces
RUN npm install && npm run build

# Build axon-server
WORKDIR /workspace/axon-server
RUN npm install && npm run build

# Build connectome-grpc-common
WORKDIR /workspace/connectome-grpc-common
RUN npm install && npm run build

# Build connectome-ts
WORKDIR /workspace/connectome-ts
RUN npm install && npm run build

# Build connectome-agent-core (ESM, pi-agent dependency)
WORKDIR /workspace/connectome-agent-core
RUN npm install && npx tsc

# Build signal-axon (type-check only — tsx handles CJS/ESM at runtime)
WORKDIR /workspace/signal-axon
RUN npm install && npx tsc --noEmit

# Set working directory for runtime
WORKDIR /workspace/signal-axon

# Environment variables
ENV NODE_ENV=production
ENV CONNECTOME_GRPC_HOST=connectome:50051
ENV SIGNAL_CLI_WS_URL=ws://signal-cli:8080
ENV SIGNAL_CLI_API_URL=http://signal-cli:8080

# Expose AXON module server port (if needed)
EXPOSE 8082

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

# Run the gRPC client via tsx (handles CJS/ESM interop)
CMD ["npx", "tsx", "src/grpc-main.ts"]
