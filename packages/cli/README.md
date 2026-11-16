# TRAWL CLI (unreleased)

The executable uses Bun by default, so a global Bun installation needs no separate Node installation. The bundled JavaScript can also be run explicitly with Node 22+ or Deno 2.

The CLI uses the native TRAWL API and manages an optional local server. The npm package name is provisional. Nothing is published by this workspace or installed through a postinstall script.

From the checkout:

```sh
bun install --frozen-lockfile
bun --cwd packages/client build
bun --cwd packages/cli build
node packages/cli/dist/index.mjs --help
```

## Existing server

```sh
export TRAWL_BASE_URL=http://localhost:8191
# Optional; keep credentials on the server side.
export TRAWL_API_KEY=your-api-token
trawl health
trawl scrape https://example.com --format html
trawl read https://example.com --format markdown
trawl extract https://example.com --options ./extract.json
trawl screenshot https://example.com --output page.jpg
trawl inspect https://example.com --output diagnostics.json
trawl metrics --minutes 60
```

Request options match the SDK. For example, `extract.json`:

```json
{"fields":{"title":{"selector":"h1"}}}
```

Use `--options -` for JSON on stdin. Target JSON bodies are serialized by the SDK, including their content type. Scrapes are not retried implicitly. `--timeout 60000` sets the client deadline; `maxTimeout` in request JSON sets the server budget. Ctrl+C cancels the client request; work already accepted by the server follows its own budget.

```sh
trawl sessions create --options ./session.json
trawl sessions scrape SESSION_ID https://example.com
trawl sessions eval SESSION_ID --options ./eval.json
trawl sessions cookies SESSION_ID
trawl sessions destroy SESSION_ID
```

Use `{"keepPage":true}` in `session.json` and `{"expression":"document.title"}` in `eval.json`. Only use eval on instances you trust.

## Local server

Install a platform-matching, trusted runtime directory built from this checkout:

```sh
trawl runtime install --from /path/to/runtime
trawl browser install
trawl browser status
# Stop the local server before repair or removal:
trawl browser repair
trawl browser uninstall
trawl browser install
trawl config profile balanced
trawl server start
trawl server status
trawl server logs
trawl server stop
```

Browser installation downloads pinned assets and verifies SHA-256 and size before activation. Runtime manifests detect incomplete or changed bundles; they are integrity checks, not proof of publisher identity. Use trusted build/release artifacts only. First setup requires internet access and at least 4 GiB free disk space. There is no browser download during npm installation.

`trawl serve` runs in the foreground. `trawl service install` enables a visible per-user login job (LaunchAgent, systemd user service or Windows scheduled task). `trawl service uninstall` removes it. This is opt-in and does not require root. Install the browser first. Desktop autostart is a separate setting; avoid enabling both managers for the same home.

The native preset binds `127.0.0.1`, uses a bounded in-memory session cache and preserves the engine's warm browser behavior. `trawl config profile economy` starts the browser on demand and closes it after 30 minutes idle; the next browser request includes launch time. It also disables optional WAF diagnostics. The scraping implementation is shared with Docker.

## Configuration

Settings resolve as flags, then environment, then the private JSON config, then defaults. A runtime setting requires a restart. All catalog flags use kebab case and explicit values:

```sh
trawl server start --port 8195 --browser-pool-size 1
trawl config set BROWSER_GEOIP_IP 8.8.8.8
trawl config set STT_API_KEY - < ./private-key.txt
trawl config show
trawl config export > settings.env
trawl config import settings.env
trawl doctor
```

`--home` / `TRAWL_HOME` selects an isolated configuration and instance. Defaults are `~/Library/Application Support/TRAWL` on macOS, `%LOCALAPPDATA%\TRAWL` on Windows and `$XDG_DATA_HOME/trawl` (or `~/.local/share/trawl`) on Linux. Back up `config.json` privately. Exports and displayed settings exclude secrets unless `config export --include-secrets` is explicit.

Stdout contains results; stderr contains errors. Exit codes: 0 success, 2 invalid input/local configuration, 3 API/network/protocol error, 4 client timeout, 130 cancelled request.
