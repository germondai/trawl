<h1 align="center">
  <a href="https://trawl.germondai.com" target="_blank">
    <img align="center" src="https://icons.germondai.com/icons?i=bun,elysia,firefox,nuxt,vitepress" /><br/><br/>
    <span>TRAWL</span>
  </a>
</h1>

## **Welcome** to <a href="https://trawl.germondai.com" target="_blank">**TRAWL**</a>! 👋

Self-hosted web scraping engine with best-effort JS challenge and CAPTCHA solving.\
Dedicated flows for Cloudflare, Akamai Bot Manager, and Imperva/Incapsula (best effort), plus Turnstile, reCAPTCHA, hCaptcha, GeeTest, ALTCHA, and Friendly Captcha.\
Much faster and more reliable FlareSolverr & Byparr alternative and drop-in replacement for your \*arr stack.

## Features

- **2-6x faster** - compared to FlareSolverr or Byparr it returns much faster with higher success rate
- **4-tier execution** - plain HTTP fetch → cached browser session → fresh challenge solve → residential proxy
- **Challenge-aware HTTP/HTTPS proxy** - direct forwarding for normal traffic, automatic tier escalation for detected walls, plus WebSockets, binary bodies, and Range/206 support
- **Multi-WAF handling** - dedicated Cloudflare, Akamai Bot Manager, and Imperva/Incapsula detection and browser flows
- **Native captcha solving** - CF Turnstile/Interstitial, reCAPTCHA v2 (free STT), hCaptcha, GeeTest v4 Slide, ALTCHA, and Friendly Captcha v1/v2
- **Camoufox Firefox** - fingerprint-patched at the C++/Juggler level to reduce automation signals
- **Session cache** - solved cookies and browser identity stored in Redis; accepted sessions can avoid a fresh solve
- **FlareSolverr compatible** - works with Prowlarr, Jackett, Sonarr, and the full \*arr ecosystem out of the box
- **No paid solver API required** - reCAPTCHA audio can use Google's free STT endpoint or an optional local Whisper service

## Sponsors

<details open>
  <summary>View/Collapse All</summary>

  <table>
    <tr>
      <td width="30%" align="center" valign="middle">
        <a href="https://get.brightdata.com/trawl" target="_blank">
          <img width="1254" height="1254" alt="Birght Data" src="https://github.com/user-attachments/assets/f23cfc4a-160d-4576-b27f-5d5bb4738530" />
        </a>
      </td>
      <td valign="middle">
        <b><a href="https://get.brightdata.com/trawl" target="_blank">Bright Data</a></b> - The most powerful platform for Web Unlocker, SERP API and web scraping tools.<br><br>
        <b>Why <a href="https://get.brightdata.com/trawl" target="_blank">Bright Data</a>?</b><br>
        • <a href="https://get.brightdata.com/trawl-web-unlocker" target="_blank">Web Unlocker</a> - bypass any anti-bot protection<br>
        • <a href="https://get.brightdata.com/trawl-serp-api" target="_blank">SERP API</a> - real-time Google, Bing & more results<br>
        • Scraping Browser & dedicated scrapers<br>
        • Massive residential proxy network<br>
        • Built for scale and reliability<br><br>
        <b>Get started for free with <a href="https://get.brightdata.com/trawl" target="_blank">Bright Data</a>!</b>
      </td>
    </tr>
    <tr>
      <td width="30%" align="center" valign="middle">
        <a href="https://go.nodemaven.com/MediaCrawlerSeptember" target="_blank">
          <img width="1047" height="262" alt="NodeMaven" src="https://github.com/user-attachments/assets/1e4e89c6-a574-462a-86bc-13c273117657" />
        </a>
      </td>
      <td valign="middle">
        <b><a href="https://go.nodemaven.com/MediaCrawlerSeptember" target="_blank">NodeMaven</a></b> - The most efficient proxy provider for Web Scrapping and Automation with the Highest Quality IP on the market.<br><br>
        <b>Why <a href="https://go.nodemaven.com/MediaCrawlerSeptember" target="_blank">NodeMaven</a>?</b><br>
        • ZIP targeting<br>
        • 99.9% uptime<br>
        • IP filtering: all proxies have fraud score <97%<br>
        • No KYC required<br>
        • Unique free tools: Proxy Bandwidth Checker, Meta Tag Checker, IP Lookup and others!<br><br>
        <b>Special codes for <a href="https://trawl.germondai.com" target="_blank">TRAWL</a> users:</b><br>
        • <code>TRAWL35</code> - 35% off to Mobile and Residential Proxies<br>
        • <code>TRAWL40</code> - 40% off to ISP (Static) Proxies
      </td>
    </tr>
    <tr>
      <td width="30%" align="center" valign="middle">
        <a href="https://www.thordata.com/?ls=dtw&lk=dtw" target="_blank">
          <img width="1254" height="1254" alt="Thordata" src="https://github.com/user-attachments/assets/32a5d8db-24c9-4779-b309-bdfdb32589f6" />
        </a>
      </td>
      <td valign="middle">
        <b><a href="https://www.thordata.com/?ls=dtw&lk=dtw" target="_blank">Thordata</a></b> - Premium Residential Proxies for Data Collection.<br><br>
        <a href="https://www.thordata.com/?ls=dtw&lk=dtw" target="_blank">Thordata</a> helps developers build reliable scraping, automation, and AI data workflows with high-quality residential IPs.<br><br>
        🌍 100M+ real IPs | 195+ countries<br>
        🔄 Rotating & sticky sessions | Precise geo-targeting<br>
        ⚡ High concurrency | Stable connections<br><br>
        Reduce blocks and collect data at scale with confidence.<br><br>
        <b>🎁 <a href="https://trawl.germondai.com" target="_blank">TRAWL</a> users:</b><br>
        • 3-day free trial + 10% OFF Code: <code>TRAWL10</code>
      </td>
    </tr>
  </table>
</details>

## Quick start

```bash
# Clone and configure
git clone https://github.com/germondai/trawl
cd trawl
cp .env.example .env

# Start scraper + Redis
docker compose up -d

# Verify
curl http://localhost:8191/health
```

First boot takes 15–30s while the browser pool warms up. Subsequent starts are fast.

### NAS app catalogs

Prefer a one-click installation? TRAWL is available from the community app
catalogs for both TrueNAS and Unraid:

- [TrueNAS Community Apps](https://apps.truenas.com/catalog/trawl_community/) —
  open **Apps → Discover Apps** and search for **TRAWL**.
- [Unraid Community Apps](https://ca.unraid.net/apps/trawl-1o4q23p06utr4h) —
  open the **Apps** tab and search for **Trawl**.

Thanks to the TrueNAS and Unraid community contributors who packaged and
published these integrations.

## API

### FlareSolverr-compatible (`/v1`)

```bash
curl -X POST http://localhost:8191/v1 \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://nowsecure.nl","maxTimeout":60000}'
```

### Native API (`/scrape`)

Returns richer metadata: `tier`, `timings`, `sessionCached`, full cookie list.

```bash
curl -X POST http://localhost:8191/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://nowsecure.nl","maxTimeout":60000}'
```

### MCP tools (`/mcp`)

Set `MCP_ENABLED=true` to expose TRAWL's client-independent Streamable HTTP tools
for readable content, HTML, screenshots and browser diagnostics to any
MCP-compatible AI application or agent. They load known public URLs; TRAWL does not
provide web search or ranking. See the
[MCP integration guide](./apps/docs/integrations/mcp.md).

### Connect Prowlarr / Jackett

Set the FlareSolverr URL to:

```
http://localhost:8191        # running on the same host
http://trawl:8191            # running via Docker Compose on the same network
```

### Challenge-bypassing HTTP/HTTPS proxy

Some sites bind their Cloudflare clearance to the solving browser's full connection
fingerprint. The `/v1` flow can't help there: Prowlarr keeps only the cookie + user-agent
and **re-fetches the page with its own HTTP client**, which Cloudflare re-challenges — the
cookie isn't portable. For those indexers, enable TRAWL's forward proxy and add it to
Prowlarr as an **HTTP proxy**:

```env
MITM_ENABLED=true
MITM_PORT=8192
MITM_CA_DIR=/data/proxy-ca   # persist the CA (mount a volume)
MITM_MAX_TIER=4              # cap escalation (e.g. 3 to stay off residential)
MITM_ALWAYS_SCRAPE=false     # opt in to bypass the proxy's direct Tier 0 probe
```

By default the listener binds `0.0.0.0` so clients on a Docker bridge network can reach
it; set `MITM_HOST=127.0.0.1` to restrict it to loopback on a bare-metal host.

1. Install the proxy's CA into the client's trust store so it accepts the per-host certs:
   `curl http://<trawl-host>:8191/proxy-ca.crt` → add to the Prowlarr container's CA store
   (e.g. a linuxserver `/custom-cont-init.d` script that copies it to
   `/usr/local/share/ca-certificates/` and runs `update-ca-certificates`).
2. Prowlarr → Settings → Indexer Proxies → **HTTP**, host `<trawl-host>`, port `8192`.
   Give it a tag if only selected indexers should use it.

Ordinary requests use a direct HTTP/TLS path. Small HTML, JSON, and text responses are buffered
for challenge detection; detected challenges escalate through the same tier pipeline as
`POST /scrape`. Videos and large binary responses stream directly. Range requests are forwarded
end to end and can escalate when their response is a detected challenge; WebSocket upgrades use a
direct relay without browser escalation.

See the complete [proxy documentation](./apps/docs/proxy/overview.md) for routing details,
supported traffic, limitations, CA installation, and client examples.

> ⚠️ A MITM proxy can impersonate any host to a client that trusts its CA. Only expose it on a
> private interface (localhost / a private Docker network), never publicly.

### Installing the proxy CA certificate

The proxy self-generates a root CA on first run. Its certificate and private key are persisted
under `MITM_CA_DIR` (default `/data/proxy-ca`). Per-host certificates are minted and cached
in memory while TRAWL runs; they do not need separate installation because they are signed by the
persistent root. Every client that uses the proxy must trust that root. Without it, HTTPS fails with
`ERR_CERT_AUTHORITY_INVALID` (browsers) or `PKIX path building failed` (Java).

Download the CA once per client:

```bash
curl http://<trawl-host>:8191/proxy-ca.crt -o trawl-ca.crt
# or in a Docker setup where the API isn't reachable from outside:
docker cp trawl:/data/proxy-ca/ca.crt ./trawl-ca.crt
```

#### macOS (system keychain — affects most apps including Safari, curl, wget)

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ./trawl-ca.crt
# Verify
security find-certificate -c "TRAWL MITM Proxy CA"
# Remove later
sudo security delete-certificate -c "TRAWL MITM Proxy CA" \
  /Library/Keychains/System.keychain
```

#### Linux (Debian/Ubuntu — system-wide for curl, wget, apt, etc.)

```bash
sudo cp trawl-ca.crt /usr/local/share/ca-certificates/trawl-ca.crt
sudo update-ca-certificates
# Verify
awk '/BEGIN/{c++} c==2' /etc/ssl/certs/ca-certificates.crt | grep -c "TRAWL MITM"
```

#### Linux (RHEL/Fedora/Amazon)

```bash
sudo cp trawl-ca.crt /etc/pki/ca-trust/source/anchors/trawl-ca.crt
sudo update-ca-trust
```

#### Firefox and NSS trust stores

Firefox installations that do not use operating-system roots need a per-profile NSS import:

```bash
# Firefox 115+ uses a file-backed NSS DB; older versions use the legacy libnssdb format.
# The certutil command is the same either way.
certutil -A -n "TRAWL MITM" -t "CT,C,C" -i trawl-ca.crt \
  -d sql:$HOME/.mozilla/firefox/<profile-dir>
# Or via Firefox UI: Settings → Privacy & Security → Certificates → View Certificates →
# Authorities → Import… → check "Trust this CA to identify websites".
# Profile dir location: about:profiles in Firefox.
```

#### Chrome / Chromium (Linux: separate from system trust)

Chrome uses the system trust store on macOS and Windows but has its own on Linux:

```bash
# Option A: launch Chrome with --user-data-dir + NSS DB update (same as Firefox).
# Option B: use Chrome's --ignore-certificate-errors-spki-list=<hash> (per-session, less safe).
# Option C: add the cert to the system store (above) — Chrome picks it up automatically on
# most Linux distros via the nss-tool lookup.
```

#### Java (including JDownloader)

```bash
# Find the JRE cacerts file for your client.
#   JDownloader:    <install>/jre/lib/security/cacerts
keytool -importcert -alias trawl -file trawl-ca.crt \
  -keystore "<path-to-cacerts>" -storepass changeit
# If `keytool` reports "Certificate already exists in keystore", use -delete first:
#   keytool -delete -alias trawl -keystore "<path-to-cacerts>" -storepass changeit
```

Prowlarr, Sonarr, and Radarr are .NET applications, not Java applications. For their
**Docker-based installations**, add the CA to the container's Linux system trust store. A common
LinuxServer pattern is a `/custom-cont-init.d` script:

```yaml
# In the client's Compose service:
volumes:
  - ./trawl-ca.crt:/config/trawl-ca.crt:ro
  - ./install-trawl-ca.sh:/custom-cont-init.d/50-install-trawl-ca:ro
```

```bash
#!/usr/bin/with-contenv bash
cp /config/trawl-ca.crt /usr/local/share/ca-certificates/trawl-ca.crt
update-ca-certificates
```

LinuxServer runs scripts in `/custom-cont-init.d/` when the container starts. Java clients such as
JDownloader require the separate `keytool` import described above.

#### JDownloader 2 (Windows / macOS / Linux — manual install)

JDownloader bundles its own JRE; the CA must be imported into it.

1. Find the JRE: `Settings → Advanced → Java Path` (in JDownloader) or look in the install dir:
   - Windows: `C:\Program Files\JDownloader 2\jre\lib\security\cacerts`
   - macOS: `/Applications/JDownloader 2.app/Contents/app/jre/lib/security/cacerts`
   - Linux: `<install>/jre/lib/security/cacerts`
2. Run the `keytool -importcert` command above against that file.
3. Restart JDownloader.

#### Windows (system trust store)

```powershell
# Run PowerShell as Administrator.
Import-Certificate -FilePath .\trawl-ca.crt `
  -CertStoreLocation Cert:\LocalMachine\Root
# Remove later
Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*TRAWL MITM*" } | Remove-Item
```

#### Removing the CA (cleanup)

Every installation method has a symmetric removal path. Search your trust store for
`TRAWL MITM Proxy CA` (the CA's CN) and delete that entry. The CA certificate and key also live at
`<MITM_CA_DIR>/ca.crt` and `ca.key` on the TRAWL host. Deleting either causes TRAWL to
generate a new root on its next start, so existing clients must install the new certificate.

## Tiers

```
Request
  │
  ▼
Tier 1: Plain HTTP fetch ────── success ──→ return (< 100ms)
  │ blocked
  ▼
Tier 2: Cached session ─────── success ──→ return (~500ms)
  │ cache miss / expired
  ▼
Tier 3: Fresh challenge solve ─ success ──→ cache + return
  │ IP flagged
  ▼
Tier 4: Residential proxy ──── success ──→ cache + return (15–45s)
  │ failed
  ▼
  error
```

## Docker Compose files

| File                         | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `docker-compose.yml`         | Scraper + Redis (default)                                |
| `docker-compose.minimal.yml` | Scraper only, no Redis                                   |
| `docker-compose.prod.yml`    | Production: `restart: always`, memory limit, healthcheck |

## Docker images (one GHCR package, two release variants)

| Image tag                          | Built from                     | Runtime                       | Use case                                                   |
| ---------------------------------- | ------------------------------ | ----------------------------- | ---------------------------------------------------------- |
| `ghcr.io/germondai/trawl:latest`   | `apps/api/Dockerfile`          | Bun 1.4.2 (modern, AVX2)     | Compact default — Linux fingerprints                       |
| `ghcr.io/germondai/trawl:baseline` | `apps/api/Dockerfile.baseline` | Bun 1.4.2 baseline (no AVX2) | Older CPUs / older kernels (Synology NAS, J4125, Atom-era) |

All tags live on the same `ghcr.io/germondai/trawl` package — they share the registry but differ in Dockerfile source or build arguments. Pick whichever tag fits your hardware and output:

```yaml
# Modern hardware (most users)
image: ghcr.io/germondai/trawl:latest

# Older CPUs without AVX2 / Synology / older kernels
image: ghcr.io/germondai/trawl:baseline
```

Synology note: many Synology NAS units (DSM 7.x on J4125 / older hardware) ship kernel 4.4.x, which Bun's modern runtime can't fully handle. Standard Bun requires kernel 5.1+ (5.6+ recommended); the baseline build degrades gracefully down to kernel 3.10. The `:baseline` tag is published for that case — **confirmed working** on a Synology DS920+ (Celeron J4125, DSM 7.3.2, kernel 4.4.302): the container starts cleanly, `/health` reports healthy, and it solves live Cloudflare challenges via `/v1` (see [#1](https://github.com/germondai/trawl/issues/1)). Published by independent GitHub Actions workflows: pushing a release tag such as `v1.6.4` creates `:1.6.4`, `:latest`, `:1.6.4-baseline`, and `:baseline`; the daily 02:00 UTC nightly build creates `:nightly` and `:nightly-<dev-sha>` from the latest `dev` commit.

## Releases & versioning

TRAWL follows [Semantic Versioning](https://semver.org/). Pushing a `v`-prefixed git tag (e.g.
`v1.0.0`) triggers `publish.yml`, which builds and pushes the matching un-prefixed Docker tag
(`ghcr.io/germondai/trawl:1.0.0`) alongside `:latest`. The moving `:nightly` tag and immutable
`:nightly-<shortsha>` tags are built from the latest verified `dev` revision every day at 02:00 UTC
or on manual dispatch; branch pushes do not publish images.
See the [Releases page](https://github.com/germondai/trawl/releases) for the full version
history and [CHANGELOG.md](CHANGELOG.md) for what changed in each one.

To publish a specific past commit that had a major fix without waiting for the next tip-of-`main`
release, tag that exact SHA and push it — `publish.yml` builds off the tag ref, not off `main`'s
current tip:

```bash
git tag -a v1.0.1 <sha> -m "..."
git push origin v1.0.1
```

## Configuration

TRAWL supports HTTP proxies, authenticated HTTP proxies, and SOCKS5 proxies. The standard Compose
files read proxy settings from the local `.env` file:

```ini
# Optional Tier 3 datacenter proxy
PROXY_URL=http://user:pass@datacenter.example.com:8080

# Optional Tier 4 residential proxy
RESIDENTIAL_PROXY_URL=socks5://user:pass@residential.example.com:1080
```

```bash
docker compose up -d
```

Leave either value empty to disable that proxy tier. Multiple endpoints can be separated with
commas; larger pools can use the corresponding `*_LIST_FILE` variable. See
[Configuration → Proxies](./apps/docs/getting-started/configuration.md#proxies)
for pool and mounted-file examples.

| Variable                         | Default                  | Description                                                                         |
| -------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `BROWSER_POOL_SIZE`              | `1`                      | Warm Camoufox Firefox instances; raise for concurrent browser solves                |
| `LOG_LEVEL`                      | `info`                   | Operational logs: `error`, `warn`, `info`, `debug`, or `silent`                     |
| `BROWSER_ACQUIRE_TIMEOUT_MS`     | `15000`                  | How long `acquire()` polls for a free browser before HTTP 429 is returned           |
| `BROWSER_RECYCLE_AFTER_CONTEXTS` | `8`                      | Rolling-replace after this many Tier 3/4 contexts; set `0` to disable               |
| `BROWSER_MAX_CONTENT_PROCESSES`  | `2`                      | Cap Firefox content processes per browser (`dom.ipc.processCount`); lowers RAM/CPU  |
| `SCRAPE_MIN_TIER`                | `1`                      | Lowest tier allowed globally (`1` HTTP, `2` cached browser, `3` fresh, `4` residential) |
| `SESSION_CACHE_DRIVER`           | `redis`                  | Session cache backend: `redis` or single-process `memory`                           |
| `REDIS_SESSION_TTL_SECONDS`      | `3600`                   | Redis or in-memory session TTL (seconds)                                            |
| `MEMORY_SESSION_CACHE_MAX_ENTRIES` | `1000`                 | Maximum LRU-bounded entries for the memory driver                                   |
| `REDIS_URL`                      | —                        | Redis connection string; empty or unset disables the Redis cache                     |
| `REDIS_CONNECT_TIMEOUT_MS`       | `5000`                   | Maximum time for each Redis connection attempt                                      |
| `REDIS_RETRY_DELAY_MS`           | `5000`                   | Delay before reconnecting after startup failure; `0` disables retry                 |
| `SCRAPE_PROXY_SELECTION`         | `failover`               | Pool policy: sticky `failover`, per-request `roundrobin`, or `random`                |
| `PROXY_URL`                      | —                        | Optional Tier 3 HTTP or SOCKS5 proxy, or comma-separated pool                       |
| `PROXY_LIST_FILE`                | —                        | File containing one Tier 3 proxy URL per line                                       |
| `RESIDENTIAL_PROXY_URL`          | —                        | Enables Tier 4 proxy escalation                                                     |
| `RESIDENTIAL_PROXY_LIST_FILE`    | —                        | File containing one Tier 4 proxy URL per line                                       |
| `STT_URL`                        | —                        | Local Whisper endpoint for reCAPTCHA (optional)                                     |
| `PORT`                           | `8191`                   | API listen port                                                                     |
| `MITM_ENABLED`                   | `false`                  | Enable the challenge-bypassing HTTP/HTTPS proxy                                     |
| `MITM_PORT`                      | `8192`                   | Forward-proxy listen port                                                           |
| `MITM_HOST`                      | `0.0.0.0`                | Bind address; `127.0.0.1` for loopback-only                                         |
| `MITM_CA_DIR`                    | `/data/proxy-ca`         | Persistent root CA certificate and private-key directory                            |
| `MITM_MAX_TIER`                  | `4`                      | Cap escalation used by the proxy (e.g. `3` to stay off residential)                 |
| `MITM_ALWAYS_SCRAPE`             | `false`                  | Skip proxy Tier 0; disables the direct media/large-file streaming path               |
| `MITM_DEBUG`                     | `false`                  | Log one line per proxied request (errors are always logged)                         |

Upgrading from an earlier release requires renaming several environment variables. See the
[configuration migration guide](apps/docs/deployment/configuration-migration.md) for the complete
old-to-new mapping and Redis opt-in behavior.

## Stack

Built on a modern, fast-by-default stack: Bun + Elysia for the API, Redis for caching,
Camoufox (hardened Firefox) for browser automation, and Nuxt for the web UI — no legacy
Node/Express baggage.

| Layer         | Technology                         |
| ------------- | ---------------------------------- |
| Runtime       | Bun                                |
| API           | Elysia                             |
| Browser       | Camoufox Firefox (via camoufox-js) |
| Session cache | Redis 8.8                          |
| Landing page  | Nuxt 4                             |
| Documentation | VitePress                          |

## License

[AGPL-3.0](LICENSE)

---

<p align="center">
    <span>Made with ❤️ by</span>
    <a href="https://github.com/germondai" target="_blank">@germondai</a>
</p>
