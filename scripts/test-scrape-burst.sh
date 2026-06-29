#!/bin/bash

# Burst-test /scrape under concurrent load against a Cloudflare-protected target.
# Pool size is typically 3 (per docker-compose.yml BROWSER_POOL_SIZE=3), so
# with CONCURRENCY=10 against a slow CF target:
#   - 3 requests → HTTP 200 with tier=3 (browser used), totalMs ≈ 30–60s
#   - 7 requests → HTTP 429 with FlareSolverr envelope after ~5s queue timeout
# Expected histogram: HTTP 200: 3, HTTP 429: 7.

# On a target that resolves at Tier 1 (HTTP fetch, no browser), every request
# should succeed quickly with tier=1 and no 429s.

# Configuration
TRAWL_URL="http://localhost:8191/scrape"
TARGET_URL="https://nopecha.com/demo/cloudflare"
MAX_TIMEOUT=60000          # 60 seconds
CONCURRENCY=10

echo "🚀 Starting $CONCURRENCY parallel requests to $TRAWL_URL → $TARGET_URL"

# Per-request scratch dir to avoid races on shared variables across &-spawned subshells.
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

for i in $(seq 1 $CONCURRENCY); do
  (
    BODY_FILE="$TMPDIR/$i.body"
    META_FILE="$TMPDIR/$i.meta"

    # -w emits two whitespace-separated values: HTTP status code + total time (s).
    META=$(curl -s -o "$BODY_FILE" -w "%{http_code} %{time_total}" \
      -X POST "$TRAWL_URL" \
      -H "Content-Type: application/json" \
      --max-time 120 \
      --data-raw '{
        "url": "'"$TARGET_URL"'",
        "maxTimeout": '"$MAX_TIMEOUT"'
      }')

    HTTP_CODE=$(echo "$META" | awk '{print $1}')
    TIME=$(echo "$META" | awk '{print $2}')
    echo "$HTTP_CODE" > "$META_FILE"
    RESPONSE=$(cat "$BODY_FILE")

    case "$HTTP_CODE" in
      200)
        # Native ScrapeResult — extract tier, statusCode, totalMs.
        # head -1 because tier/statusCode/totalMs appear in nested timings[]
        # and in redirect HTML bodies, which would leak newlines into the echo.
        TIER=$(echo "$RESPONSE" | grep -o '"tier":[0-9]*' | head -1 | cut -d: -f2)
        STATUS_CODE=$(echo "$RESPONSE" | grep -o '"statusCode":[0-9]*' | head -1 | cut -d: -f2)
        TOTAL_MS=$(echo "$RESPONSE" | grep -o '"totalMs":[0-9]*' | head -1 | cut -d: -f2)
        echo "✅ [$i/$CONCURRENCY] HTTP 200 time=${TIME}s | tier=$TIER statusCode=$STATUS_CODE totalMs=${TOTAL_MS}ms"
        ;;
      429)
        # FlareSolverr envelope — uniform with /v1
        STATUS=$(echo "$RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
        MESSAGE=$(echo "$RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
        VERSION=$(echo "$RESPONSE" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
        echo "⚠️  [$i/$CONCURRENCY] HTTP 429 time=${TIME}s (pool exhausted) | status=$STATUS version=$VERSION message=\"$MESSAGE\""
        ;;
      503)
        # Pool initializing — native { error }
        ERROR=$(echo "$RESPONSE" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
        echo "⏳ [$i/$CONCURRENCY] HTTP 503 time=${TIME}s (pool initializing) | error=\"$ERROR\""
        ;;
      500)
        # Generic scrape exception — native { error }
        ERROR=$(echo "$RESPONSE" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
        echo "❌ [$i/$CONCURRENCY] HTTP 500 time=${TIME}s | error=\"$ERROR\""
        ;;
      *)
        echo "❓ [$i/$CONCURRENCY] HTTP $HTTP_CODE time=${TIME}s (unexpected)"
        echo "   Response preview: ${RESPONSE:0:300}..."
        ;;
    esac
  ) &
done

wait

echo ""
echo "📊 Status histogram:"
# Extract HTTP status from each .meta file, then count occurrences.
# Avoids bash 4+ associative arrays (macOS /bin/bash is 3.2).
{
  for f in "$TMPDIR"/*.meta; do
    awk '{print $1}' "$f"
  done
} | sort | uniq -c | awk '{printf "  HTTP %s: %d\n", $2, $1}'

echo ""
echo "✅ All $CONCURRENCY requests completed!"
