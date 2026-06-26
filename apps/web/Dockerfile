FROM oven/bun:1.3.14-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN bun --bun install

COPY . ./
RUN bunx --bun nuxt generate

FROM nginx:alpine AS runner

COPY --from=builder /app/.output/public /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
