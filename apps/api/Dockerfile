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
# --linker=hoisted avoids Bun's default isolated-linker bugs that corrupt
# multi-stage Docker builds: transitive deps not symlinked (oven-sh/bun#23524,
# e.g. @sinclair/typebox via elysia) and a store-population race producing
# EISDIR on freshly-linked packages (oven-sh/bun#29489, e.g. camoufox-js).
# The `--omit=dev` flag is the modern spelling — `--production` alone leaves workspace
# devDeps installed (bun 1.3.x quirk). Prune better-sqlite3 sources + unused impit
# platform binaries inside this stage so the subsequent COPY --from=deps in stage 3
# pulls a smaller layer (Docker layers are unions, not diffs — can't shrink post-COPY).
RUN bun install --frozen-lockfile --production --omit=dev --linker=hoisted \
 && find node_modules -path '*/better-sqlite3*/deps' -prune -exec rm -rf {} + \
 && find node_modules -path '*/better-sqlite3*/src'   -prune -exec rm -rf {} + \
 && find node_modules -path '*/better-sqlite3*' -name '*.md'  -delete \
 && find node_modules -path '*/better-sqlite3*' -name '*.gyp' -delete \
 && find node_modules -path '*/better-sqlite3*' -name '*.c'   -delete \
 && find node_modules -path '*/better-sqlite3*' -name '*.h'   -delete \
 && find node_modules -path '*/better-sqlite3*' -name '*.map' -delete \
 && rm -rf node_modules/typescript node_modules/bun-types node_modules/@types \
 && rm -rf node_modules/impit-linux-arm64-musl \
         node_modules/impit-linux-x64-musl \
         node_modules/impit-darwin-* \
         node_modules/impit-win32-*

# ── Stage 2: fetch the Camoufox Firefox binary (pinned version) ─────
FROM oven/bun:1.3.14 AS camoufox
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*

# Pin Camoufox to v150.0.2-beta.25 (verified working). The camoufox-js `fetch` always
# downloads the latest release, which broke in 152.x (browser binary no longer in the
# zip — see Camoufox upstream release notes). Direct curl keeps builds reproducible.
#
# Asset naming: arm64 = alpha.25 build, x86_64 = alpha.26 rebuild (only x86_64 was
# rebuilt in the v150.0.2-beta.25 release).
ARG TARGETARCH
RUN --mount=type=secret,id=GITHUB_TOKEN,env=GITHUB_TOKEN \
    case "$TARGETARCH" in \
      amd64) ZIP="camoufox-150.0.2-alpha.26-lin.x86_64.zip" ;; \
      arm64) ZIP="camoufox-150.0.2-alpha.25-lin.arm64.zip" ;; \
      *) echo "unsupported arch: $TARGETARCH"; exit 1 ;; \
    esac && \
    curl -fsSL \
      "https://github.com/daijro/camoufox/releases/download/v150.0.2-beta.25/${ZIP}" \
      -o /tmp/camoufox.zip && \
    unzip -q /tmp/camoufox.zip -d /opt/camoufox && \
    rm /tmp/camoufox.zip && \
    printf '{"version":"150.0.2","release":"alpha.26"}\n' > /opt/camoufox/version.json && \
    chmod -R 755 /opt/camoufox && \
    rm -rf /opt/camoufox/fonts/macos /opt/camoufox/fonts/windows

# ── Stage 3: lean runtime (only API-required files) ────────────────────────────
# debian:bookworm-slim replaces ubuntu:22.04 — same glibc family, ~50 MB smaller base.
# Camoufox/Firefox require glibc; Alpine's musl is incompatible.
FROM debian:bookworm-slim
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
      curl \
    && apt-get clean

COPY --from=oven/bun:1.3.14  /usr/local/bin/bun /usr/local/bin/bun
COPY --from=camoufox          /opt/camoufox      /opt/camoufox
COPY --from=deps              /app/node_modules  /app/node_modules

# Strip debug symbols — Bun is statically linked (safe to strip-all); Firefox's glibc/NSS
# .so files keep their dynamic symbols via --strip-unneeded. Saves ~75 MB uncompressed
# without affecting runtime behaviour. `|| true` so a strip failure on one file
# doesn't abort the build.
RUN strip --strip-all /usr/local/bin/bun 2>/dev/null || true \
 && find /opt/camoufox -type f \( -name 'firefox' -o -name 'firefox-bin' -o -name '*.so*' \) \
        -exec strip --strip-unneeded {} + 2>/dev/null || true

COPY packages/types/   /app/packages/types/
COPY packages/browser/ /app/packages/browser/
COPY packages/tiers/   /app/packages/tiers/
COPY apps/api/         /app/apps/api/
COPY package.json      /app/

ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
WORKDIR /app
EXPOSE 8191
CMD ["bun", "run", "apps/api/src/index.ts"]
