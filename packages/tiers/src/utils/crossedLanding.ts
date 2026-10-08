import { FINGERPRINT } from "@trawl/browser"
import type { OutboundUrlValidator } from "./outboundPolicy"

// Crossed-landing guard for scrapes that asked for `ignoreCertificateErrors`.
//
// A verified certificate is what normally proves the bytes came from the host that was
// asked for. Switch verification off and that proof is gone: a connection that reaches the
// wrong origin - a poisoned or misconfigured DNS answer, an SNI-blind proxy, a shared-IP
// virtual host falling back to its default vhost - is accepted in silence, and the whole
// scrape (html, favicons, logos) comes back for someone else's site under the requested
// domain's name. Refusing to serve another site's page is the point of this module;
// failing the fetch is the safer outcome.
//
// Landing off the requested host is usually a legitimate redirect, though, so an off-host
// landing on its own says nothing. It only counts as crossed when a plain HTTP fetch of the
// same URL, through the same egress, stays on the requested host - i.e. nothing about the
// requested host leads anywhere near where the scrape ended up. A probe that fails, or that
// lands somewhere else again (an ordinary redirect, or cloaking), is inconclusive and keeps
// the scrape.
//
// Two deliberate choices:
//   * hosts are compared by suffix relation rather than by registrable domain - TRAWL
//     carries no public-suffix list, and "same registrable domain" guessed without one
//     reads `evil.co.uk` and `bank.co.uk` as the same site. Suffix comparison is the
//     stricter side of that trade-off, and the probe is what keeps it from over-refusing.
//   * the probe honours the request's own TLS policy: on a host whose certificate is
//     invalid - the whole reason this code path exists - a verifying probe could only ever
//     fail, which would make the guard silently inert exactly where it is needed.

// How long the probe waits for the requested URL to answer.
export const CROSSED_LANDING_PROBE_TIMEOUT_MS = 10_000

// Independent egresses that must land on the same off-host address before it is taken as a
// real browser-only redirect rather than a wrong origin. Counted per egress: the same proxy
// reaching the same wrong origin twice is one observation repeated, not a confirmation.
export const CROSSED_LANDING_CONFIRMATIONS = 2

// Redirect hops the probe will follow when it has to resolve them itself (an outbound
// policy is installed, so every hop must be validated before it is requested).
const MAX_PROBE_REDIRECTS = 9

// A document request, not an asset one - a site that serves different content to a
// non-browser client would otherwise redirect the probe somewhere the scrape never saw.
const PROBE_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
}

export interface LandingProbeOptions {
  // The egress the scrape itself used, so the probe sees the same routing and the same
  // geo-dependent redirects.
  proxy?: string
  // The user agent the scrape presented, so UA-keyed cloaking cannot split the two.
  userAgent?: string
  ignoreCertificateErrors?: boolean
  // The scrape's remaining time budget, capped at CROSSED_LANDING_PROBE_TIMEOUT_MS.
  timeoutMs?: number
  // The same outbound policy the tiers enforce. When present the probe resolves redirects
  // itself and validates every hop, so the guard cannot become a way to reach a host the
  // policy forbids.
  validateOutboundUrl?: OutboundUrlValidator
}

// Resolves the host a plain HTTP fetch of `url` ends on, or null when it cannot say.
export type LandingProbe = (url: string, options: LandingProbeOptions) => Promise<string | null>

// URLs reach here from the caller and can carry credentials or tokens in userinfo and
// query string, so logs get the origin and path only - enough to find the scrape again.
export function forLog(candidate: string): string {
  try {
    const url = new URL(candidate)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return "<unparseable url>"
  }
}

export function hostOf(candidate: string | null | undefined): string | null {
  if (!candidate) return null
  try {
    // Trailing dots are legal in a hostname and denote the same host.
    return new URL(candidate).hostname.toLowerCase().replace(/\.$/, "") || null
  } catch {
    return null
  }
}

// True when `other` is the same host as `requested`, or one is a subdomain of the other
// (`example.com` <-> `www.example.com`). Both are already lowercased by hostOf().
export function isSameSite(requested: string, other: string): boolean {
  return requested === other || other.endsWith(`.${requested}`) || requested.endsWith(`.${other}`)
}

export const probeLandingHost: LandingProbe = async (url, options) => {
  const timeout = Math.min(CROSSED_LANDING_PROBE_TIMEOUT_MS, options.timeoutMs ?? CROSSED_LANDING_PROBE_TIMEOUT_MS)
  if (timeout <= 0) return null
  const deadline = Date.now() + timeout
  const validate = options.validateOutboundUrl
  let response: Response | undefined
  try {
    let currentUrl = url
    for (let redirects = 0; ; redirects++) {
      await validate?.(currentUrl)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error("Probe deadline exceeded")
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: validate ? "manual" : "follow",
        headers: { "User-Agent": options.userAgent ?? FINGERPRINT.userAgent, ...PROBE_HEADERS },
        // Every redirect shares one deadline. Resetting the full timeout per hop could
        // let a long chain exceed the scrape's remaining maxTimeout budget many times.
        signal: AbortSignal.timeout(remaining),
        ...(options.proxy ? { proxy: options.proxy } : {}),
        ...(options.ignoreCertificateErrors ? { tls: { rejectUnauthorized: false } } : {}),
      })
      if (!validate || ![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get("location")
      if (!location) break
      if (redirects >= MAX_PROBE_REDIRECTS) throw new Error("Too many redirects")
      await response.body?.cancel().catch(() => {})
      currentUrl = new URL(location, currentUrl).href
    }
    // With a manual walk the browser-visible final URL is the last hop we requested;
    // `response.url` is the same thing when fetch followed the chain itself.
    return hostOf(response.url || url)
  } catch (err) {
    // Inconclusive, not crossed - the caller keeps the scrape.
    console.log(
      `[crossed-landing] probe failed for ${forLog(url)}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  } finally {
    // The probe only needs the final URL; never pull the body down.
    await response?.body?.cancel().catch(() => {})
  }
}

export interface CrossedLandingGuard {
  // Returns the host the scrape must not be served from, or null to keep the result.
  check(landedUrl: string | undefined, options: LandingProbeOptions): Promise<string | null>
}

export function createCrossedLandingGuard(
  requestedUrl: string,
  probe: LandingProbe = probeLandingHost,
): CrossedLandingGuard {
  const requested = hostOf(requestedUrl)
  // Off-host landing -> the egresses that reached it.
  const crossings = new Map<string, Set<string>>()

  return {
    async check(landedUrl, options) {
      const landed = hostOf(landedUrl)
      if (!requested || !landed || isSameSite(requested, landed)) return null
      // A spent scrape budget makes the guard inconclusive; it must not start new I/O
      // after the caller's deadline merely to manufacture a security decision.
      if (options.timeoutMs !== undefined && options.timeoutMs <= 0) return null

      const probed = await probe(requestedUrl, options)
      if (!probed || !isSameSite(requested, probed)) return null

      const egresses = crossings.get(landed) ?? new Set<string>()
      egresses.add(options.proxy ?? "direct")
      crossings.set(landed, egresses)
      if (egresses.size >= CROSSED_LANDING_CONFIRMATIONS) {
        // Independent egresses agreeing on the same off-host landing is a redirect only a
        // browser performs, not one connection that reached the wrong origin.
        console.log(
          `[crossed-landing] ${requested} -> ${landed} seen from ${egresses.size} egresses — accepting as a real redirect`,
        )
        return null
      }
      console.log(`[crossed-landing] ${forLog(requestedUrl)} landed on ${landed}, a host ${requested} does not lead to`)
      return landed
    },
  }
}
