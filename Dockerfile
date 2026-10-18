# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS app-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js server.js ./
COPY public ./public
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM colmap/colmap:20260929.8466@sha256:c1de51615dff33066cd305071226b6343c1168324ef3bd622f0825e55feb5efe

WORKDIR /app
COPY --from=app-build /usr/local/bin/node /usr/local/bin/node
COPY --from=app-build /app/node_modules ./node_modules
COPY --from=app-build /app/package.json ./package.json
COPY --from=app-build /app/server.js ./server.js
COPY --from=app-build /app/dist ./dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATA_DIR=/workspace/realresale-data

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.js"]
