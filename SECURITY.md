# Security Policy

## Supported versions

Only the latest stable release receives security fixes. Older releases are not
patched separately. The `dev` branch may contain fixes that have not shipped yet;
merging a fix does not update previously published images or existing deployments.

## Deployment and trust model

TRAWL is a single-operator service. Keep its API and proxy on a trusted network or
behind an authenticated gateway; native scraping and FlareSolverr `/v1` do not
authenticate callers. A dashboard token protects dashboard history, not the API.

Native scraping, browser sessions and the MITM proxy intentionally support
operator-selected local and private-network destinations. API access also grants
access to session cookies, retained pages and session evaluation. These interfaces
are not a sandbox for untrusted callers or a shared public scraping service.

MCP adds a public-destination policy for agent-supplied URLs. Bypasses of that
policy are in scope even when the MCP caller itself is trusted: the target page
and its redirects can be attacker-controlled. MCP checks and pins destination IPs
at connection time, uses a separate clearance cache, and accepts only sessions
created with `publicOnly: true`. HTTPS remains end-to-end. Native interfaces retain
the operator authority described above. Network isolation remains useful
defence in depth and does not replace fixing a bypass in the policy.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately through either of these channels (in order of preference):

1. **GitHub Security Advisories** - open a [private security advisory](https://github.com/germondai/trawl/security/advisories/new) on this repository.
2. **Email** - `security@trawl.germondai.com`

Both channels reach the maintainer (@germondai). Please include:

- A clear description of the vulnerability and its impact.
- Reproduction steps (PoC code, `curl` commands, screenshots - whatever you have).
- The affected version or commit SHA.
- Whether you intend to disclose publicly, and on what timeline.

## Response timeline

- **Acknowledgement** - within 72 hours.
- **Triage & impact assessment** - within 7 days.
- **Patch** - as soon as practical, typically within 30 days for high-severity issues.

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure): the report stays private until a fix is released, after which the advisory is published with credit to the reporter (unless they prefer anonymity).

## Scope

In scope:

- Anything in `apps/api/` that lets an unauthenticated remote actor read or modify data they shouldn't.
- Anything in `packages/browser/` that escapes the browser sandbox or exposes host state.
- Anything in the Redis-backed session cache that leaks another operator's session.
- Supply-chain issues in pinned dependencies (compromised lockfile entries, malicious transitive packages).

Out of scope:

- The scraper's ability to bypass Cloudflare or other anti-bot measures against sites the operator doesn't own or have permission to test against. TRAWL is a tool - operators are responsible for using it legally.
- Reports that depend on social engineering, physical access, or a compromised operator account.
- Voluntary rate-limiting or DoS conditions triggered by design (the API is single-tenant by default).
- Issues only present in unsupported versions (see Supported versions above).

## Recognition

Reporters who follow this policy are credited in the fix release notes unless they request otherwise. Thank you for helping keep TRAWL and its users safe.
