ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
# postinstall runs `prisma generate`, so the schema must exist before install
COPY apps/api/prisma apps/api/prisma
RUN npm ci --workspace @covaflux/api --workspace @covaflux/shared

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @covaflux/shared \
  && npm run build -w @covaflux/api \
  && npm prune --omit=dev --workspace @covaflux/api --workspace @covaflux/shared

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY apps/api/docker-entrypoint.sh /usr/local/bin/covaflux-entrypoint
RUN chmod 0755 /usr/local/bin/covaflux-entrypoint && mkdir -p /data && chown node:node /data
WORKDIR /app/apps/api
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/covaflux-entrypoint"]
# Call the Prisma CLI directly: npx would need a writable npm cache.
CMD ["sh", "-c", "node ../../node_modules/prisma/build/index.js migrate deploy && exec node dist/server.js"]
