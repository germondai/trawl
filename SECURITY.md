# Security Policy

## Supported versions

TRAWL is currently in pre-1.0 development (`0.1.x`). Only the latest minor release receives security fixes; older versions are not patched.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅ Active  |
| < 0.1   | ❌ No      |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately through either of these channels (in order of preference):

1. **GitHub Security Advisories** — open a [private security advisory](https://github.com/germondai/trawl/security/advisories/new) on this repository.
2. **Email** — `security@trawl.dev`

Both channels reach the maintainer (@germondai). Please include:

- A clear description of the vulnerability and its impact.
- Reproduction steps (PoC code, `curl` commands, screenshots — whatever you have).
- The affected version or commit SHA.
- Whether you intend to disclose publicly, and on what timeline.

## Response timeline

- **Acknowledgement** — within 72 hours.
- **Triage & impact assessment** — within 7 days.
- **Patch** — as soon as practical, typically within 30 days for high-severity issues.

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure): the report stays private until a fix is released, after which the advisory is published with credit to the reporter (unless they prefer anonymity).

## Scope

In scope:

- Anything in `apps/api/` that lets an unauthenticated remote actor read or modify data they shouldn't.
- Anything in `packages/browser/` that escapes the browser sandbox or exposes host state.
- Anything in the Redis-backed session cache that leaks another operator's session.
- Supply-chain issues in pinned dependencies (compromised lockfile entries, malicious transitive packages).

Out of scope:

- The scraper's ability to bypass Cloudflare or other anti-bot measures against sites the operator doesn't own or have permission to test against. TRAWL is a tool — operators are responsible for using it legally.
- Reports that depend on social engineering, physical access, or a compromised operator account.
- Voluntary rate-limiting or DoS conditions triggered by design (the API is single-tenant by default).
- Issues only present in unsupported versions (see table above).

## Recognition

Reporters who follow this policy are credited in the fix release notes unless they request otherwise. Thank you for helping keep TRAWL and its users safe.
