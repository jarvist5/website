FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# Optional build-only trust for managed development proxies; no certificate is retained.
RUN --mount=type=secret,id=platform_ca \
    if [ -s /run/secrets/platform_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/platform_ca; fi; \
    npm ci --cache /tmp/leafivo-npm-cache --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1
COPY src ./src
COPY public ./public
COPY index.html vite.config.js ./
RUN --mount=type=secret,id=platform_ca \
    if [ -s /run/secrets/platform_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/platform_ca; fi; \
    npm run build \
    && npm prune --omit=dev --cache /tmp/leafivo-npm-cache --no-audit --no-fund

FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    STORE_MODE=preview \
    PUBLIC_PREVIEW=true \
    DATABASE_PATH=/app/.data/store.sqlite \
    DOWNLOAD_DIR=/app/private-downloads

COPY --chown=node:node package.json package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
RUN mkdir -p /app/.data /app/private-downloads \
    && chown node:node /app/.data /app/private-downloads \
    && chmod 700 /app/.data /app/private-downloads
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health');if(!r.ok)process.exit(1)"
CMD ["node", "server/index.js"]
