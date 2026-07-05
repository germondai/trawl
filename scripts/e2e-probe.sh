#!/usr/bin/env bash
# E2E probe suite for TRAWL — covers every supported verb, sanitisation,
# validation, and the legacy FlareSolverr shape. Run while the container is up.
set -uo pipefail
BASE="${BASE:-http://localhost:8191}"
ok=0
fail=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf "  \033[32mOK\033[0m   %-60s -> %s\n" "$name" "$actual"
    ok=$((ok+1))
  else
    printf "  \033[31mFAIL\033[0m %-60s -> got %s, want %s\n" "$name" "$actual" "$expected"
    fail=$((fail+1))
  fi
}

probe() {
  local name="$1" expected="$2"; shift 2
  local code
  code=$(curl -s -o /tmp/probe-body -w "%{http_code}" "$@")
  check "$name" "$expected" "$code"
  if [[ "$code" != "$expected" ]]; then
    echo "       body: $(head -c 300 /tmp/probe-body)"
  fi
}

echo "=== 1. health & stats ==="
probe "/health -> 200"                       200 -X GET "$BASE/health"
probe "/stats -> 200"                        200 -X GET "$BASE/stats"

echo
echo "=== 2. native /scrape — full verb set (upstream method in JSON body) ==="
# /scrape is registered as POST at the HTTP layer. The upstream HTTP verb the
# scraper uses is passed inside the JSON body (`method` field). All upstream
# verbs except GET must declare Content-Type upstream-side via `headers`.
for verb in GET POST PUT PATCH DELETE HEAD OPTIONS TRACE QUERY; do
  case "$verb" in
    GET|HEAD|OPTIONS|TRACE)
      payload=$(printf '{"url":"https://example.com/","method":"%s"}' "$verb")
      expected=200
      ;;
    *)
      payload=$(printf '{"url":"https://example.com/","method":"%s","body":"k=v","headers":{"Content-Type":"application/x-www-form-urlencoded"}}' "$verb")
      expected=200
      ;;
  esac
  probe "/scrape upstream-method=$verb -> $expected" "$expected" \
    -X POST "$BASE/scrape" \
    -H 'content-type: application/json' \
    --data "$payload"
done

echo
echo "=== 3. native /scrape — negative ==="
probe "/scrape CONNECT -> 400" 400 \
  -X POST "$BASE/scrape" \
  -H 'content-type: application/json' \
  --data '{"url":"https://example.com/","method":"CONNECT"}'
probe "/scrape POST no Content-Type -> 400" 400 \
  -X POST "$BASE/scrape" \
  -H 'content-type: application/json' \
  --data '{"url":"https://example.com/","method":"POST","body":"k=v","headers":{}}'
probe "/scrape Host header (sanitised) -> 200" 200 \
  -X POST "$BASE/scrape" \
  -H 'content-type: application/json' \
  --data '{"url":"https://example.com/","headers":{"Host":"evil.example","X-Custom":"keep-me"}}'

echo
echo "=== 4. legacy /v1 (FlareSolverr compat) ==="
probe "/v1 request.get -> 200" 200 \
  -X POST "$BASE/v1" \
  -H 'content-type: application/json' \
  --data '{"cmd":"request.get","url":"https://example.com/"}'
probe "/v1 request.post + Content-Type -> 200" 200 \
  -X POST "$BASE/v1" \
  -H 'content-type: application/json' \
  --data '{"cmd":"request.post","url":"https://example.com/post","postData":"hello=world","headers":{"Content-Type":"application/x-www-form-urlencoded"}}'
probe "/v1 request.post no Content-Type -> 400" 400 \
  -X POST "$BASE/v1" \
  -H 'content-type: application/json' \
  --data '{"cmd":"request.post","url":"https://example.com/post","postData":"hello=world","headers":{}}'
probe "/v1 unknown cmd -> 400" 400 \
  -X POST "$BASE/v1" \
  -H 'content-type: application/json' \
  --data '{"cmd":"request.delete","url":"https://example.com/"}'

echo
echo "=== 5. large body — no cap (~500 KiB) ==="
big=$(python3 -c "import string,random; random.seed(0); print(''.join(random.choices(string.ascii_letters+string.digits,k=512000)),end='')")
probe "/scrape POST large body (uncapped) -> 200" 200 \
  -X POST "$BASE/scrape" \
  -H 'content-type: application/json' \
  --data "$(python3 -c "import json,sys; print(json.dumps({'url':'https://example.com/','method':'POST','body':sys.argv[1],'headers':{'Content-Type':'text/plain'}}))" "$big")"

echo
echo "-----------------------------------------------------"
echo "Total: $ok passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
