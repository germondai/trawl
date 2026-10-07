# ── Stage 1: install workspace deps (runs natively on build host) ──────────────
FROM oven/bun:1.4.2 AS deps
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
 && rm -rf node_modules/typescript node_modules/bun-types node_modules/@types node_modules/@typescript \
 && test -z "$(find node_modules -path '*/@typescript/typescript-*' -print -quit)" \
 && rm -rf node_modules/impit-linux-arm64-musl \
         node_modules/impit-linux-x64-musl \
         node_modules/impit-darwin-* \
         node_modules/impit-win32-*

# ── Stage 2: fetch the Camoufox Firefox binary (pinned version) ─────
FROM oven/bun:1.4.2 AS camoufox
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox

ARG UBO_VERSION=1.75.0
ARG UBO_AMO_FILE_ID=5034826
ARG UBO_SHA256=5b74415860456370644bd80f16125e865b0e6c356bb5dfcfb84069967eaa5287

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip ca-certificates binutils && rm -rf /var/lib/apt/lists/*

# Pin the browser release and verify the architecture-specific asset before extracting it.
# Direct downloads keep builds reproducible and avoid camoufox-js resolving "latest".
ARG TARGETARCH
# The pool spoofs a per-browser OS (packages/browser/src/pool.ts maps Win32 -> "windows",
# MacIntel -> "macos"), and Camoufox spoofs that OS's font list with it. Dropping those
# bundles therefore leaves a browser advertising fonts whose files are gone: every glyph
# renders as a tofu box, and the fingerprint is self-inconsistent for anti-bot scoring.
# Set CAMOUFOX_KEEP_SPOOFED_OS_FONTS=1 to keep them (+891MB) when rendered output matters.
ARG CAMOUFOX_KEEP_SPOOFED_OS_FONTS=0
RUN --mount=type=secret,id=GITHUB_TOKEN,env=GITHUB_TOKEN \
    case "$TARGETARCH" in \
      amd64) ZIP="camoufox-152.0.4-beta.30-lin.x86_64.zip"; SHA256="5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672" ;; \
      arm64) ZIP="camoufox-152.0.4-beta.30-lin.arm64.zip"; SHA256="60447260af8bebdb0ec3f2aa72f687b879e5598367303de2e3fdbc7a5be8c124" ;; \
      *) echo "unsupported arch: $TARGETARCH"; exit 1 ;; \
    esac && \
    curl -fsSL \
      "https://github.com/daijro/camoufox/releases/download/v152.0.4-beta.30/${ZIP}" \
      -o /tmp/camoufox.zip && \
    echo "${SHA256}  /tmp/camoufox.zip" | sha256sum --check --strict - && \
    unzip -q /tmp/camoufox.zip -d /opt/camoufox && \
    rm /tmp/camoufox.zip && \
    printf '{"version":"152.0.4","release":"beta.30"}\n' > /opt/camoufox/version.json && \
    chmod -R 755 /opt/camoufox && \
    if [ "$CAMOUFOX_KEEP_SPOOFED_OS_FONTS" != "1" ]; then \
      rm -rf /opt/camoufox/fonts/macos /opt/camoufox/fonts/windows; \
    fi

# Strip in the producing stage, before COPY creates a runtime layer.
RUN strip --strip-unneeded /opt/camoufox/camoufox /opt/camoufox/camoufox-bin \
 && find /opt/camoufox -type f \( -name '*.so*' -o -name 'firefox-bin' \) -exec strip --strip-unneeded {} +

# Bake the GeoIP database so camoufox-js never downloads it at runtime.
# `geoip: true` (packages/browser/src/pool.ts) otherwise makes camoufox-js fetch
# GeoLite2-City.mmdb from P3TERX/GeoLite.mmdb on first browser launch, into
# $CAMOUFOX_INSTALL_DIR. An interrupted/truncated download leaves a corrupt file that
# camoufox-js reuses forever (getGeolocation only re-downloads when the file is absent),
# crashing every launch with "Invalid Extended Type at offset N val 7" (issue #20).
# Baking a verified copy into the image makes startup deterministic and removes the
# runtime GitHub dependency + first-launch download latency. The size check fails the
# build if the download is truncated, so a corrupt file can never be baked in.
# P3TERX/GeoLite.mmdb retains only its two most recent releases, so a pinned tag 404s
# within days and every build after that fails on curl exit 22 — which is what happened
# to the 2026.08.07 and 2026.08.19 pins. Track the rolling latest and keep the guarantee
# that actually matters here (a truncated file is never baked in) with a size floor; the
# digest of a release that gets deleted cannot be kept current, and it was never a
# provenance check on MaxMind's data anyway.
ARG GEOLITE_CITY_MIN_BYTES=50000000
RUN curl -fsSL \
      "https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-City.mmdb" \
      -o /opt/camoufox/GeoLite2-City.mmdb && \
    actual=$(stat -c%s /opt/camoufox/GeoLite2-City.mmdb) && \
    [ "$actual" -ge "${GEOLITE_CITY_MIN_BYTES}" ] || \
      { echo "GeoLite2-City.mmdb is $actual bytes, below ${GEOLITE_CITY_MIN_BYTES}" >&2; exit 1; }

# Bake uBlock Origin into Camoufox's expected addon directory. camoufox-js still
# performs its normal addon registration at startup, but no runtime download or
# extraction is needed (including when /opt/camoufox is read-only).
RUN curl -fsSL \
      "https://addons.mozilla.org/firefox/downloads/file/${UBO_AMO_FILE_ID}/ublock_origin-${UBO_VERSION}.xpi" \
      -o /tmp/ubo.xpi && \
    echo "${UBO_SHA256}  /tmp/ubo.xpi" | sha256sum --check --strict - && \
    mkdir -p /opt/camoufox/addons/UBO && \
    unzip -q /tmp/ubo.xpi -d /opt/camoufox/addons/UBO && \
    test -f /opt/camoufox/addons/UBO/manifest.json && \
    test "$(bun -e 'console.log(JSON.parse(await Bun.file("/opt/camoufox/addons/UBO/manifest.json").text()).version)')" = "${UBO_VERSION}" && \
    rm /tmp/ubo.xpi

FROM oven/bun:1.4.2 AS bun-runtime
RUN apt-get update && apt-get install -y --no-install-recommends binutils \
 && strip --strip-all /usr/local/bin/bun

# ── Stage 3: lean runtime (only API-required files) ────────────────────────────
# Camoufox/Firefox require glibc; Alpine's musl is incompatible.
FROM debian:trixie-slim
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
      ffmpeg \
      xvfb \
      ca-certificates \
      curl \
      tini \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /usr/share/locale /usr/share/doc /usr/share/man

COPY --from=bun-runtime     /usr/local/bin/bun /usr/local/bin/bun
COPY --from=camoufox          /opt/camoufox      /opt/camoufox
COPY --from=deps              /app/node_modules  /app/node_modules

COPY packages/types/   /app/packages/types/
COPY packages/browser/ /app/packages/browser/
COPY packages/tiers/   /app/packages/tiers/
COPY apps/api/         /app/apps/api/
COPY package.json      /app/

ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox \
    HOME=/tmp \
    # Safe Bun runtime knobs — all tested runtime-neutral (no behavior change).
    BUN_DISABLE_CJS=1 \
    BUN_DEBUG=0 \
    BUN_DISABLE_SOURCEMAPS=1 \
    BUN_HTTP_KEEPALIVE=0 \
    BUN_AGENT_DISABLE=1 \
    BUN_INSPECT=0 \
    BUN_LOCKFILE_MIGRATION=false \
    MIMALLOC_PURGE_DELAY=0 \
    NODE_NO_WARNINGS=1

WORKDIR /app
EXPOSE 8191
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "apps/api/src/index.ts"]
