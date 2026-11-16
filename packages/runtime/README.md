# Native runtime (unreleased)

Private build and lifecycle package for the CLI and desktop. It packages the existing Bun server, browser launcher, native PoW solver, offline WAF helper and audio helper. It does not introduce a second scraping engine.

```sh
bun --cwd packages/runtime build
```

Output: `.artifacts/v2/runtime`. Build on the target OS/architecture with Bun 1.4.4, Rust and Go (the version in `tools/wafmeow/go.mod`). The launcher runs a bundled private Bun executable; end users do not need Bun, Python or Docker. The browser is installed separately on first setup:

```sh
./trawl-server setup
./trawl-server profile economy   # optional; balanced is the warm default
./trawl-server serve --port 8191
# Optional visible login job, using the extracted bundle's executable:
./trawl-server service install
./trawl-server service uninstall
```

Use `trawl-server --help`, `config` and `doctor` without installing the npm CLI. On Windows the executable is `trawl-server.exe`. Keep the whole runtime directory together; the launcher needs its adjacent resources. The bundle records its actual Bun version and inherits that build's CPU requirements; the initial x64 CI uses standard Bun (AVX2). Existing baseline Docker images are unchanged. Linux still needs the browser's system libraries and Xvfb; the desktop additionally needs WebKitGTK and a tray implementation.

The build keeps a 20 GiB disk reserve and uses two compiler workers. Ephemeral CI runners can set `TRAWL_BUILD_MIN_FREE_GIB` (minimum 4). This build reserve is separate from the smaller installation requirement.

Local management uses a private Unix socket / Windows named pipe and a random token in the per-user instance file. It never sends configuration administration through the public HTTP API. A control request is not an arbitrary command. Saved connection secrets are redacted in frontend responses; dashboard HTTP calls go through a bounded Rust transport.

One managed process owns each home. CLI service and desktop instances do not take over each other's processes. Quit stops desktop-owned processes; an explicit Stop command can stop the chosen local instance. Parent-pipe EOF handles desktop failure; the Windows launcher additionally places the engine and all descendants in a kill-on-close Job Object at creation. Unix uses normal signal cleanup, with process-group cleanup for a desktop-owned process that exceeds its shutdown budget.

Stop the managed server before replacing its runtime. Installation holds the same per-home lifecycle lock as startup, so another process cannot start against a runtime while it is being replaced.

Managed loopback HTTP rejects cross-origin browser requests and rebound Host headers. Exact `host.docker.internal` and `host.orb.internal` Host names are accepted for container-to-host connections without widening the listener. Explicit LAN binding changes exposure; use an authenticated TLS reverse proxy before allowing untrusted clients. No new cloud authentication or multi-tenant isolation is provided.

Configuration, control state and logs use private user storage. Logs are sampled every ten seconds and compacted at 20 MiB, retaining at most three 20 MiB histories. The current log can exceed the threshold between checks. Browser/download staging is discarded after failure; activation preserves the previous installation until verification completes.

User jobs write to the same private `logs/server.log` as desktop-managed servers. A terminal Ctrl+C requests graceful shutdown; Windows forwards it through an owned pipe while retaining a Job Object for crash cleanup. Closing the entire Windows console or signing out is subject to the operating system's shutdown deadline.

`BROWSER_SHUTDOWN_DRAIN_MS` preserves the engine default of `0`, which closes accepted API requests immediately. Set it to a suitable finite budget, such as `10000`, to let those requests finish before pool cleanup. Parent-disconnect and explicit Stop use the same configured budget.

The native bundle carries its verified GeoIP database because the upstream download only retains recent releases. Browser and add-on downloads remain explicit first-run setup operations. Cancellation removes partial files and releases the installation lock; concurrent installers cannot replace each other's work.

Native distributions remain in development. Each target must pass native CI and installation checks; public macOS and Windows artifacts additionally require distribution signing and, on macOS, notarization.

Browser status distinguishes a missing, incomplete or incompatible installation from a ready browser. Desktop repair and uninstall use the private management interface and reject a running managed instance. Activation is protected by the same lifecycle lock as startup. Native defaults remain loopback-only and use private metrics/certificate paths even after importing an empty config.
