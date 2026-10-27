# Haze harness: everything is installed and vendored at BUILD time.
# Startup does no package installs, no engine downloads, no dataset fetches.
FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Pinned Meterless engines (H-MEM + World Model) and their conformance suites.
COPY scripts/setup_engines.mjs scripts/setup_engines.mjs
RUN node scripts/setup_engines.mjs

COPY . .
RUN npx tsc --noEmit

ENV STATE_DIR=/data \
    LOG_DIR=/data/logs \
    PORT=8000
EXPOSE 8000
VOLUME ["/data"]
CMD ["node", "--import", "tsx", "src/server.ts"]
