#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
image=${1:-trawl-smoke}

# Separate processes keep each suite's browser and Bun memory independent.
suites=(
  apps/api/src/shutdown.integration.test.ts
  apps/api/src/browserSessions.integration.test.ts
  apps/api/src/proxySessions.integration.test.ts
  apps/api/src/httpReplay.integration.test.ts
  apps/api/src/turnstile.integration.test.ts
  apps/api/src/cloudflareFallback.integration.test.ts
  apps/api/src/externalCaptcha.integration.test.ts
  packages/browser/tests/metaRefresh.integration.test.ts
  packages/browser/tests/rawText.integration.test.ts
  packages/browser/tests/readiness.integration.test.ts
)
if [[ "${TRAWL_POOL_RESOURCE_TESTS:-0}" == "1" ]]; then
  suites+=(apps/api/src/poolResources.integration.test.ts)
fi

for suite in "${suites[@]}"
do
  memory_limit=1g
  runtime_user=0:0
  # Persistent contexts need headroom; the runtime memory guard may retire them.
  if [[ "$suite" == apps/api/src/browserSessions.integration.test.ts || "$suite" == apps/api/src/shutdown.integration.test.ts ]]; then
    memory_limit=2g
  fi
  # Catch root-owned browser caches baked into runtime images.
  if [[ "$suite" == packages/browser/tests/readiness.integration.test.ts ]]; then
    runtime_user=1000:1000
  fi
  docker run --rm --user="$runtime_user" --memory="$memory_limit" --memory-swap="$memory_limit" --shm-size=256m \
    -e SESSION_CACHE_DRIVER=memory -e METRICS_DB_PATH=:memory: \
    -e TIER1_TRANSPORT="${TIER1_TRANSPORT:-bun}" \
    -e BROWSER_POOL_SIZE=1 -e BROWSER_HEADFUL_POOL_SIZE=0 \
    -e BROWSER_HARDWARE_CONCURRENCY=4 -e BROWSER_MAX_CONTENT_PROCESSES=2 \
    -e BROWSER_BLOCK_ADS=false \
    -e TRAWL_BROWSER_SESSION_TESTS=1 -e TRAWL_BROWSER_TESTS=1 \
    -e TRAWL_RAW_TEXT_TESTS=1 -e TRAWL_READINESS_TESTS=1 \
    -e TRAWL_PROXY_SESSION_TESTS=1 \
    -e TRAWL_HTTP_REPLAY_TESTS=1 \
    -e TRAWL_TURNSTILE_TESTS=1 \
    -e TRAWL_CLOUDFLARE_FALLBACK_TESTS=1 \
    -e TRAWL_EXTERNAL_CAPTCHA_TESTS=1 \
    -e TRAWL_SHUTDOWN_TESTS=1 \
    -e TRAWL_POOL_RESOURCE_TESTS="${TRAWL_POOL_RESOURCE_TESTS:-0}" \
    -v "$repo_root/packages/browser/tests:/app/packages/browser/tests:ro" \
    -v "$repo_root/apps/api/src/browserSessions.integration.test.ts:/app/apps/api/src/browserSessions.integration.test.ts:ro" \
    -v "$repo_root/apps/api/src/shutdown.integration.test.ts:/app/apps/api/src/shutdown.integration.test.ts:ro" \
    -v "$repo_root/apps/api/src/proxySessions.integration.test.ts:/app/apps/api/src/proxySessions.integration.test.ts:ro" \
    -v "$repo_root/apps/api/src/httpReplay.integration.test.ts:/app/apps/api/src/httpReplay.integration.test.ts:ro" \
    -v "$repo_root/apps/api/src/turnstile.integration.test.ts:/app/apps/api/src/turnstile.integration.test.ts:ro" \
    -v "$repo_root/apps/api/src/cloudflareFallback.integration.test.ts:/app/apps/api/src/cloudflareFallback.integration.test.ts:ro" \
    -v "$repo_root/apps/api/src/externalCaptcha.integration.test.ts:/app/apps/api/src/externalCaptcha.integration.test.ts:ro" \
    -v "$repo_root/apps/api/src/poolResources.integration.test.ts:/app/apps/api/src/poolResources.integration.test.ts:ro" \
    --entrypoint bun "$image" test "$suite"
done
