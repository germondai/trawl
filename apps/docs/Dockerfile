FROM oven/bun:1.4.2-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/docs/package.json ./apps/docs/
COPY packages/types/package.json ./packages/types/
COPY packages/browser/package.json ./packages/browser/
COPY packages/tiers/package.json ./packages/tiers/
RUN bun install --frozen-lockfile --filter '@trawl/docs' --linker=hoisted

COPY apps/docs/ ./apps/docs/
WORKDIR /app/apps/docs
RUN bun run build

FROM nginx:1.31.6-alpine AS runner

COPY --from=builder /app/apps/docs/.vitepress/dist /usr/share/nginx/html
COPY apps/docs/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
