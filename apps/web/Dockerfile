# Nuxt's build tooling requires Node APIs that Bun does not implement yet.
FROM node:26.13.0-alpine AS builder
COPY --from=oven/bun:1.4.4-alpine /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/docs/package.json ./apps/docs/
COPY packages/client/package.json ./packages/client/
COPY packages/types/package.json ./packages/types/
COPY packages/browser/package.json ./packages/browser/
COPY packages/tiers/package.json ./packages/tiers/
RUN bun install --frozen-lockfile --filter '@trawl/web' --linker=hoisted

COPY apps/web/ ./apps/web/
WORKDIR /app/apps/web
RUN node /app/node_modules/nuxt/bin/nuxt.mjs generate

FROM nginx:1.31.8-alpine AS runner

COPY --from=builder /app/apps/web/.output/public /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
