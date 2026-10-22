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
COPY --from=build /app/scripts/run-example.mjs ./scripts/run-example.mjs
COPY --from=build /app/input_examples ./input_examples
COPY --from=build /app/engine_sources.json /app/package.json /app/package-lock.json /app/THIRD_PARTY_NOTICES.md ./
ENV STATE_DIR=/data
RUN mkdir -p /data /app/logs && chown node:node /data /app/logs
USER node
# Run the same offline checkpoint example as npm start.
CMD ["node", "scripts/run-example.mjs", "input_examples/01-minimal.json"]
