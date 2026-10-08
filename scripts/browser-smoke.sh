#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
image=${1:-trawl-smoke}

# Separate processes keep each suite's browser and Bun memory independent.
for suite in \
  apps/api/src/browserSessions.integration.test.ts \
  packages/browser/tests/metaRefresh.integration.test.ts \
  packages/browser/tests/rawText.integration.test.ts \
  packages/browser/tests/readiness.integration.test.ts
do
  memory_limit=1g
  # Persistent contexts need headroom; the runtime memory guard may retire them.
  if [[ "$suite" == apps/api/src/browserSessions.integration.test.ts ]]; then
    memory_limit=2g
  fi
  docker run --rm --memory="$memory_limit" --memory-swap="$memory_limit" --shm-size=256m \
    -e SESSION_CACHE_DRIVER=memory -e METRICS_DB_PATH=:memory: \
    -e BROWSER_POOL_SIZE=1 -e BROWSER_HEADFUL_POOL_SIZE=0 \
    -e BROWSER_HARDWARE_CONCURRENCY=4 -e BROWSER_MAX_CONTENT_PROCESSES=2 \
    -e BROWSER_BLOCK_ADS=false \
    -e TRAWL_BROWSER_SESSION_TESTS=1 -e TRAWL_BROWSER_TESTS=1 \
    -e TRAWL_RAW_TEXT_TESTS=1 -e TRAWL_READINESS_TESTS=1 \
    -v "$repo_root/packages/browser/tests:/app/packages/browser/tests:ro" \
    -v "$repo_root/apps/api/src/browserSessions.integration.test.ts:/app/apps/api/src/browserSessions.integration.test.ts:ro" \
    --entrypoint bun "$image" test "$suite"
done
