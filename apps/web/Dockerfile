FROM oven/bun:1.4.2-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/docs/package.json ./apps/docs/
COPY packages/types/package.json ./packages/types/
COPY packages/browser/package.json ./packages/browser/
COPY packages/tiers/package.json ./packages/tiers/
RUN bun install --frozen-lockfile --filter '@trawl/web' --linker=hoisted

COPY apps/web/ ./apps/web/
WORKDIR /app/apps/web
RUN bunx --bun nuxt generate

FROM nginx:1.31.6-alpine AS runner

COPY --from=builder /app/apps/web/.output/public /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
