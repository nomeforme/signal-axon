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
COPY connectome-grpc ./connectome-grpc
COPY signal-axon ./signal-axon

# Build connectome-axon-interfaces
WORKDIR /workspace/connectome-axon-interfaces
RUN npm install && npm run build

# Build connectome-grpc
WORKDIR /workspace/connectome-grpc
RUN npm install && npm run build

# Build signal-axon (standalone - does not depend on connectome-ts)
WORKDIR /workspace/signal-axon
RUN npm install && npm run build

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

# Run the gRPC client
CMD ["node", "dist/grpc-main.js"]
