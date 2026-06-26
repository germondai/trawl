# ── Stage 1: install workspace deps (runs natively on build host) ──────────────
FROM oven/bun:1.3.14 AS deps
WORKDIR /app

# nodejs/python3/make/g++ are needed to compile better-sqlite3 (camoufox-js dep)
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
COPY packages/types/package.json   ./packages/types/
COPY packages/browser/package.json ./packages/browser/
COPY packages/tiers/package.json   ./packages/tiers/
COPY apps/api/package.json         ./apps/api/
COPY apps/web/package.json         ./apps/web/
COPY apps/docs/package.json        ./apps/docs/

# --production skips devDependencies (vitepress + algolia from docs, typescript, @types)
RUN bun install --frozen-lockfile --production

# ── Stage 2: fetch the Camoufox Firefox binary ─────────
FROM oven/bun:1.3.14 AS camoufox
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox

RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm python3 make g++ && rm -rf /var/lib/apt/lists/*

# Use BuildKit cache for the download
RUN --mount=type=secret,id=GITHUB_TOKEN,env=GITHUB_TOKEN \
    --mount=type=cache,target=/root/.cache/camoufox,sharing=locked \
    bun x camoufox-js fetch \
    && rm -rf /opt/camoufox/fonts/macos /opt/camoufox/fonts/windows

# Secret mount keeps GITHUB_TOKEN out of image layers.
# Token prevents GitHub API rate-limits that cause the binary download to stall.
RUN --mount=type=secret,id=GITHUB_TOKEN,env=GITHUB_TOKEN \
    bun x camoufox-js fetch \
    && rm -rf /opt/camoufox/fonts/macos /opt/camoufox/fonts/windows

# ── Stage 3: lean runtime (only API-required files) ────────────────────────────
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libcairo2 libcairo-gobject2 \
      libdbus-1-3 libdbus-glib-1-2 \
      libfontconfig1 \
      libgdk-pixbuf-2.0-0 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 libnss3 \
      libpango-1.0-0 libpangocairo-1.0-0 \
      libx11-6 libx11-xcb1 libxcb1 libxcb-shm0 \
      libxcomposite1 libxcursor1 libxdamage1 \
      libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
      libdrm2 libgbm1 \
      libasound2 \
      fonts-liberation \
      ca-certificates \
    && apt-get clean

COPY --from=oven/bun:1.3.14  /usr/local/bin/bun /usr/local/bin/bun
COPY --from=camoufox          /opt/camoufox      /opt/camoufox
COPY --from=deps              /app/node_modules  /app/node_modules

COPY packages/types/   /app/packages/types/
COPY packages/browser/ /app/packages/browser/
COPY packages/tiers/   /app/packages/tiers/
COPY apps/api/         /app/apps/api/
COPY package.json      /app/

# Workspace node_modules (relative symlinks into root .bun/ tree — must come after source COPY)
# packages/types has no production deps so no node_modules dir is created
COPY --from=deps /app/apps/api/node_modules          /app/apps/api/node_modules
COPY --from=deps /app/packages/browser/node_modules  /app/packages/browser/node_modules
COPY --from=deps /app/packages/tiers/node_modules    /app/packages/tiers/node_modules

ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
WORKDIR /app
EXPOSE 8191
CMD ["bun", "run", "apps/api/src/index.ts"]
