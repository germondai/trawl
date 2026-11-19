# Optional usage collector

A separate Bun service. It is not started by the TRAWL desktop/API, has no configured public deployment and receives nothing until an operator explicitly enables sharing and sets its HTTPS URL.

```sh
TELEMETRY_ADMIN_TOKEN='<at least 32 random characters>' bun --cwd apps/telemetry start
# Or, from the repository root:
docker build -f apps/telemetry/Dockerfile -t trawl-usage .
docker run --rm -p 127.0.0.1:8198:8198 -v trawl-usage:/data \
  -e TELEMETRY_ADMIN_TOKEN trawl-usage
```

Serve `/v1/events` through your HTTPS reverse proxy. Configure `TELEMETRY_ENABLED=true` and `TELEMETRY_ENDPOINT=https://your-host/v1/events` on an instance, then restart. Switching sharing off also takes effect after restart. No collector address is baked into the app. Run `GET /health` for readiness. `GET /v1/stats` requires `Authorization: Bearer <TELEMETRY_ADMIN_TOKEN>` and returns the newest 1,000 aggregate rows; keep this admin token separate from instance credentials.

The sender accepts only target hostname, a known challenge enum (or `unknown`), success, duration rounded to 10ms and server version. It omits URL paths, query parameters, bodies, credentials, cookies, raw logs and persistent client IDs. Literal IPs, single-label and recognized local/reserved names are omitted. Hostnames can still identify a site; the receiver and reverse proxy see the network connection's IP. This is voluntary usage sharing, not a promise of untraceable transport. Configure proxy access logs accordingly. Unknown challenge means the operation did not record a recognized challenge, not that it encountered none.

Each sender holds at most 100 events in memory, uploads batches of 20 once a minute and drops failures without retries. Requests use verified HTTPS, no cookies/credentials, no redirects and a two-second timeout; one transport may be in flight. Reporting never waits on the scrape response.

The collector validates the same exact schema, rejects extra fields, caps a batch at 20 events/16 KiB and keeps IP rate counters only in memory (120 POSTs/minute per direct peer, 1,024 peers). It does not trust forwarded-IP headers. Apply additional source-IP rate limits at the HTTPS proxy, especially when all traffic arrives from one proxy peer. Public ingestion is intentionally write-only and can still receive fabricated statistics; aggregates are diagnostic evidence, not authoritative billing or success-rate proof.

SQLite stores hourly domain/challenge/outcome/duration-bucket/version aggregates, not individual events or client IPs. Entries expire after 30 days; cleanup runs at startup, every minute and before authenticated statistics reads or ingestion. Database growth is capped at 8,192 SQLite pages (normally 32 MiB), with bounded rollback journal overhead; storage failures return 503 without affecting client scraping. Persistent database files are private on Unix. Back up the `/data` volume if aggregate history matters.

Public deployment, DNS/TLS, reverse proxy limits and a stable collector URL remain deployment steps; this code has not published a service.
