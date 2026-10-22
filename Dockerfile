FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
RUN npm install --global npm@11.8.0
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
# All upstream source is already pinned in the build context. No runtime setup.
RUN npm run build && npm run test:engines

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/engine_sources.json /app/package.json /app/package-lock.json /app/THIRD_PARTY_NOTICES.md ./
ENV STATE_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
# The repository currently provides libraries, not the architecture's future API.
# Exercise actual local engines by default; applications can override this command.
CMD ["node", "--input-type=module", "-e", "import { join } from 'node:path'; import { openHazeEngines } from './dist/engines/index.js'; const engines = await openHazeEngines({ memoryDirectory: join(process.env.STATE_DIR, 'hmem'), worldDirectory: join(process.env.STATE_DIR, 'world-model'), namespace: 'haze' }); console.log(JSON.stringify(engines.provenance));"]
