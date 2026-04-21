# syntax=docker/dockerfile:1.6
# -----------------------------------------------------------------------------
# Multi-stage image producing lean runtime containers for each off-chain service
# (indexer, api, bot). The Anchor program is built separately via `anchor build`.
# -----------------------------------------------------------------------------

FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json* ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json   packages/shared/
COPY packages/indexer/package.json  packages/indexer/
COPY packages/api/package.json      packages/api/
COPY packages/bot/package.json      packages/bot/
RUN npm install --include=dev --workspaces

FROM deps AS build
COPY packages ./packages
RUN npm run build --workspaces
# Prune dev deps for runtime stages
RUN npm prune --omit=dev --workspaces

FROM base AS indexer
COPY --from=build /app/node_modules                 ./node_modules
COPY --from=build /app/package.json                 ./
COPY --from=build /app/packages/shared/dist          packages/shared/dist
COPY --from=build /app/packages/shared/package.json  packages/shared/
COPY --from=build /app/packages/indexer/dist         packages/indexer/dist
COPY --from=build /app/packages/indexer/package.json packages/indexer/
COPY packages/indexer/migrations                     packages/indexer/migrations
CMD ["node", "packages/indexer/dist/main.js"]

FROM base AS api
COPY --from=build /app/node_modules                 ./node_modules
COPY --from=build /app/package.json                 ./
COPY --from=build /app/packages/shared/dist          packages/shared/dist
COPY --from=build /app/packages/shared/package.json  packages/shared/
COPY --from=build /app/packages/api/dist             packages/api/dist
COPY --from=build /app/packages/api/package.json     packages/api/
EXPOSE 4000
CMD ["node", "packages/api/dist/main.js"]

FROM base AS bot
COPY --from=build /app/node_modules                 ./node_modules
COPY --from=build /app/package.json                 ./
COPY --from=build /app/packages/shared/dist          packages/shared/dist
COPY --from=build /app/packages/shared/package.json  packages/shared/
COPY --from=build /app/packages/bot/dist             packages/bot/dist
COPY --from=build /app/packages/bot/package.json     packages/bot/
CMD ["node", "packages/bot/dist/main.js"]
