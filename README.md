<h1 align="center">
  <a href="https://trawl.germondai.com" target="_blank">
    <img align="center" src="https://icons.germondai.com/icons?i=bun,elysia,firefox,nuxt,vitepress" /><br/><br/>
    <span>TRAWL</span>
  </a>
</h1>

## **Welcome** to <a href="https://trawl.germondai.com" target="_blank">**TRAWL**</a>! 👋

Self-hosted web scraping engine with best-effort JS challenge and CAPTCHA solving.\
Dedicated flows for Cloudflare, AWS WAF, Akamai Bot Manager, and Imperva/Incapsula (best effort), plus Turnstile, reCAPTCHA, hCaptcha, and GeeTest.\
Much faster and more reliable FlareSolverr & Byparr alternative and drop-in replacement for your \*arr stack.

## Features

- **2-6x faster** - compared to FlareSolverr or Byparr it returns much faster with higher success rate
- **4-tier execution** - plain HTTP fetch → cached browser session → fresh challenge solve → residential proxy
- **Challenge-aware HTTP/HTTPS proxy** - direct forwarding for normal traffic, automatic tier escalation for detected walls, plus WebSockets, binary bodies, and Range/206 support
- **Multi-WAF handling** - dedicated Cloudflare, AWS WAF, Akamai Bot Manager, and Imperva/Incapsula detection and browser flows
- **Native captcha solving** - CF Turnstile/Interstitial, AWS WAF CAPTCHA audio, reCAPTCHA v2 audio, hCaptcha, GeeTest v4 Slide
- **Camoufox Firefox** - fingerprint-patched at the C++/Juggler level to reduce automation signals
- **Session cache** - solved cookies and browser identity stored in Redis; accepted sessions can avoid a fresh solve
- **FlareSolverr compatible** - works with Prowlarr, Jackett, Sonarr, and the full \*arr ecosystem out of the box
- **No paid solver API required** - reCAPTCHA and AWS WAF audio can use the bundled STT path or an optional local Whisper service

## Sponsors

<details open>
  <summary>View/Collapse All</summary>

  <table>
    <tr>
      <td width="30%" align="center" valign="middle">
        <a href="https://go.nodemaven.com/germondaiGitHub" target="_blank">
          <img width="720" height="300" alt="nodemaven" src="https://github.com/user-attachments/assets/5dbfaee7-7863-4a20-a4a0-eb9f7bf0a90a" />
        </a>
      </td>
      <td valign="middle">
        <b><a href="https://go.nodemaven.com/germondaiGitHub" target="_blank">NodeMaven</a></b> - The most reliable proxy provider with the Highest Quality IP on the market. Best solution for automation, web scraping, SEO research, and social media management.<br><br>
        <b>Why <a href="https://go.nodemaven.com/germondaiGitHub" target="_blank">NodeMaven</a>?</b><br>
        • 99.9% uptime<br>
        • Sticky sessions up to 7 days<br>
        • IP filtering: all proxies have fraud score <97%<br>
        • No KYC required<br>
        • Cashback on traffic - burn GB and earn up to 10% back<br><br>
        <b>Special codes for <a href="https://trawl.germondai.com" target="_blank">TRAWL</a> users:</b><br>
        • TRAWL35 - 35% off to Mobile and Residential Proxies<br>
        • TRAWL40 - 40% off to ISP (Static) Proxies
      </td>
    </tr>
    <tr>
      <td width="30%" align="center" valign="middle">
        <a href="https://www.swiftproxy.net/?code=ICOTZM44K" target="_blank">
          <img width="240" height="100" alt="swiftproxy" src="https://github.com/user-attachments/assets/d7112814-182b-46b9-b359-cf48ca69d4cc" />
        </a>
      </td>
      <td valign="middle">
        <b><a href="https://www.swiftproxy.net/?code=ICOTZM44K" target="_blank">Swiftproxy</a></b> - A global residential proxy provider offering 80M+ real residential IPs across 190+ countries and regions. Built for web scraping, browser automation, AI workflows, SEO monitoring, and multi-account management.<br><br>
        <b>Why <a href="https://www.swiftproxy.net/?code=ICOTZM44K" target="_blank">Swiftproxy</a>?</b><br>
        • Non-expiring residential traffic<br>
        • Rotating & sticky sessions<br>
        • HTTP, HTTPS & SOCKS5 support<br>
        • Country, state & city-level targeting<br>
        • 24/7 technical support<br><br>
        <b>Exclusive offer for <a href="https://trawl.germondai.com" target="_blank">TRAWL</a> users:</b><br>
        • PROXY90 - Get 10% OFF all proxy plans<br>
        • Free Trial Available
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
MITM_PROXY_ENABLED=true
MITM_PROXY_PORT=8192
MITM_PROXY_CA_DIR=/data/proxy-ca   # persist the CA (mount a volume)
MITM_PROXY_MAX_TIER=4              # cap escalation (e.g. 3 to stay off residential)
```

By default the listener binds `0.0.0.0` so clients on a Docker bridge network can reach
it; set `MITM_PROXY_HOST=127.0.0.1` to restrict it to loopback on a bare-metal host.

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
under `MITM_PROXY_CA_DIR` (default `/data/proxy-ca`). Per-host certificates are minted and cached
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
`<MITM_PROXY_CA_DIR>/ca.crt` and `ca.key` on the TRAWL host. Deleting either causes TRAWL to
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

## Docker images (one GHCR package, two tags)

| Image tag                          | Built from                     | Runtime                       | Use case                                                   |
| ---------------------------------- | ------------------------------ | ----------------------------- | ---------------------------------------------------------- |
| `ghcr.io/germondai/trawl:latest`   | `apps/api/Dockerfile`          | Bun 1.3.14 (modern, AVX2)     | Default — modern Linux amd64/arm64                         |
| `ghcr.io/germondai/trawl:baseline` | `apps/api/Dockerfile.baseline` | Bun 1.3.14 baseline (no AVX2) | Older CPUs / older kernels (Synology NAS, J4125, Atom-era) |

Both tags live on the same `ghcr.io/germondai/trawl` package — they share the registry but use different Dockerfile sources. Pick whichever tag fits your hardware:

```yaml
# Modern hardware (most users)
image: ghcr.io/germondai/trawl:latest

# Older CPUs without AVX2 / Synology / older kernels
image: ghcr.io/germondai/trawl:baseline
```

Synology note: many Synology NAS units (DSM 7.x on J4125 / older hardware) ship kernel 4.4.x, which Bun's modern runtime can't fully handle. Standard Bun requires kernel 5.1+ (5.6+ recommended); the baseline build degrades gracefully down to kernel 3.10. The `:baseline` tag is published for that case — **confirmed working** on a Synology DS920+ (Celeron J4125, DSM 7.3.2, kernel 4.4.302): the container starts cleanly, `/health` reports healthy, and it solves live Cloudflare challenges via `/v1` (see [#1](https://github.com/germondai/trawl/issues/1)). Published by independent GitHub Actions workflows (`.github/workflows/publish.yml`, `publish-baseline.yml`); tag-triggered releases push matching git tags (e.g. `v1.0.0` → `1.0.0`, `1.0.0-baseline` → `1.0.0-baseline`) and manual `workflow_dispatch` from `main` updates the rolling tag (`latest` and `baseline` respectively).

## Releases & versioning

TRAWL follows [Semantic Versioning](https://semver.org/). Pushing a `v`-prefixed git tag (e.g.
`v1.0.0`) triggers `publish.yml`, which builds and pushes the matching un-prefixed Docker tag
(`ghcr.io/germondai/trawl:1.0.0`) alongside a major-only tag (`:1`). `:latest` always tracks the
tip of `main`; `:sha-<shortsha>` images are pushed on every `main` commit regardless of tags.
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
| `BROWSER_POOL_SIZE`              | `3`                      | Warm Camoufox Firefox instances                                                     |
| `BROWSER_ACQUIRE_TIMEOUT_MS`     | `15000`                  | How long `acquire()` polls for a free browser before HTTP 429 is returned           |
| `BROWSER_RECYCLE_AFTER_CONTEXTS` | `8`                      | Rolling-replace after this many Tier 3/4 contexts; set `0` to disable               |
| `BROWSER_CONTENT_PROCESSES`      | `2`                      | Cap Firefox content processes per browser (`dom.ipc.processCount`); lowers RAM/CPU  |
| `SESSION_TTL_SECONDS`            | `3600`                   | Redis session cache TTL (seconds)                                                   |
| `REDIS_URL`                      | `redis://localhost:6379` | Redis connection string                                                             |
| `PROXY_URL`                      | —                        | Optional Tier 3 HTTP or SOCKS5 proxy, or comma-separated pool                       |
| `PROXY_LIST_FILE`                | —                        | File containing one Tier 3 proxy URL per line                                       |
| `RESIDENTIAL_PROXY_URL`          | —                        | Enables Tier 4 proxy escalation                                                     |
| `RESIDENTIAL_PROXY_LIST_FILE`    | —                        | File containing one Tier 4 proxy URL per line                                       |
| `STT_URL`                        | —                        | Whisper-compatible endpoint for reCAPTCHA/AWS WAF audio (optional; recommended for AWS WAF) |
| `PORT`                           | `8191`                   | API listen port                                                                     |
| `MITM_PROXY_ENABLED`             | `false`                  | Enable the challenge-bypassing HTTP/HTTPS proxy                                     |
| `MITM_PROXY_PORT`                | `8192`                   | Forward-proxy listen port                                                           |
| `MITM_PROXY_HOST`                | `0.0.0.0`                | Bind address; `127.0.0.1` for loopback-only                                         |
| `MITM_PROXY_CA_DIR`              | `/data/proxy-ca`         | Persistent root CA certificate and private-key directory                            |
| `MITM_PROXY_MAX_TIER`            | `4`                      | Cap escalation used by the proxy (e.g. `3` to stay off residential)                 |
| `MITM_PROXY_DEBUG`               | `false`                  | Log one line per proxied request (errors are always logged)                         |

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
