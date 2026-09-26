# Build context is the repo root. The web UI has no build step and is served
# straight from web/, which server.ts resolves relative to dist/ (../web).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY web/ web/
COPY package.json ./
# Runs as the unprivileged node user. mcp.json (if any) is mounted here from a
# Secret at runtime; FRIDAY_MCP_CONFIG points at it (see deploy/k8s.yaml).
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
