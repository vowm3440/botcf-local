# ---- build stage -----------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /repo

COPY package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm install --workspaces --include-workspace-root

COPY . .
RUN npm run build -w apps/web && npm run build -w apps/server
RUN npm prune --omit=dev --workspaces --include-workspace-root

# ---- runtime stage ---------------------------------------------------------
FROM node:22-alpine

RUN addgroup -g 1001 app && adduser -u 1001 -G app -s /sbin/nologin -D app \
    && mkdir -p /data /workspaces && chown -R app:app /data /workspaces

WORKDIR /app
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/server/package.json ./apps/server/package.json
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/web/dist ./apps/web/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7788 \
    BOTCF_DATA_DIR=/data \
    WEB_DIST_DIR=/app/apps/web/dist

USER app
EXPOSE 7788

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7788/health || exit 1

CMD ["node", "apps/server/dist/server.js"]
