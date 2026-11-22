FROM oven/bun:1.4.5-alpine
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/telemetry/ ./packages/telemetry/
COPY apps/telemetry/ ./apps/telemetry/
RUN bun install --frozen-lockfile --filter '@trawl/telemetry-server' --production --omit=dev --linker=hoisted \
    && mkdir /data && chown bun:bun /data
USER bun
ENV HOST=0.0.0.0 PORT=8198 TELEMETRY_DB_PATH=/data/usage.sqlite
EXPOSE 8198
CMD ["bun", "apps/telemetry/src/index.ts"]
