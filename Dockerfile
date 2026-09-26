# Build context is the repo root. One image for the whole workspace: core, the
# in-process modules it depends on, and the built portal (served from /app/web).
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/core/package.json packages/core/
COPY packages/portal/package.json packages/portal/
COPY packages/portal-ui/package.json packages/portal-ui/
COPY modules/builtin/package.json modules/builtin/
COPY modules/media/package.json modules/media/
COPY remote/simracing/package.json remote/simracing/
RUN pnpm install --frozen-lockfile
COPY packages/ packages/
COPY modules/ modules/
COPY remote/ remote/
RUN pnpm -r --filter '!@friday/remote-simracing' build \
 && pnpm --filter @friday/core deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
ENV FRIDAY_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /out/ ./
COPY --from=build /app/packages/portal/dist/ web/
# Runs as the unprivileged node user. mcp.json (if any) is mounted here from a
# Secret at runtime; FRIDAY_MCP_CONFIG points at it (see deploy/k8s.yaml).
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
