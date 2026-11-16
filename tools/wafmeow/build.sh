#!/bin/sh
set -eu
cd "$(dirname "$0")"
go mod download
waf_module=$(go list -m -f '{{.Dir}}' github.com/Lu1sDV/wafmeow/v3)
mkdir -p dist
waf_binary=dist/trawl-waf
if [ "$(go env GOOS)" = "windows" ]; then waf_binary="$waf_binary.exe"; fi
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$waf_binary" .
cp -f "$waf_module/cmd/wafmeow/resources/waf-fingerprints.json" dist/
# Includes upstream WAFW00F BSD attribution as well as wafmeow's MIT licence.
cp -f "$waf_module/LICENSE.md" dist/LICENSE
