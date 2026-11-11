#!/bin/sh
set -eu
cd "$(dirname "$0")"
go mod download
waf_module=$(go list -m -f '{{.Dir}}' github.com/Lu1sDV/wafmeow/v3)
mkdir -p dist
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o dist/trawl-waf .
cp "$waf_module/cmd/wafmeow/resources/waf-fingerprints.json" dist/
# Includes upstream WAFW00F BSD attribution as well as wafmeow's MIT licence.
cp "$waf_module/LICENSE.md" dist/LICENSE
