export type ChallengeType =
  | "cloudflare-interstitial"
  | "cloudflare-turnstile"
  | "hcaptcha"
  | "recaptcha"
  | "cap"
  | "imperva"
  | "akamai"
  | "ddos-guard"
  | "aws-waf"
  | "datadome"
  | "none"

export function hasCloudflareChallengeHeader(headers: Record<string, string> = {}): boolean {
  const cfMitigated = Object.entries(headers).find(([name]) => name.toLowerCase() === "cf-mitigated")?.[1]
  return cfMitigated?.toLowerCase() === "challenge"
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

export type AwsWafAction = "challenge" | "captcha"

export function getAwsWafAction(
  status: number | undefined,
  headers: Record<string, string> = {},
): AwsWafAction | undefined {
  const action = headerValue(headers, "x-amzn-waf-action")?.trim().toLowerCase()
  if (status === 202 && action === "challenge") return "challenge"
  if (status === 405 && action === "captcha") return "captcha"
  return undefined
}

export function isCloudflarePage(html: string, headers: Record<string, string>): boolean {
  if (hasCloudflareChallengeHeader(headers)) return true
  if (hasDdosGuardChallenge(html)) return false
  if (/<title>[^<]*(just a moment|please wait|checking|attention required)[^<]*<\/title>/i.test(html)) return true
  if (/checking your browser/i.test(html)) return true
  if (/enable javascript and cookies to continue/i.test(html)) return true
  if (/verify you are human/i.test(html)) return true
  // id-based checks: specific to CF challenge DOM, not present in real pages
  if (/id="challenge-running"/i.test(html)) return true
  if (/id="cf-challenge-running"/i.test(html)) return true
  // CF Turnstile interstitial wrapper
  if (/id="turnstile-wrapper"/i.test(html)) return true
  // Active challenge orchestration markers. Unlike the passive telemetry markers
  // below, these only occur while Cloudflare is serving an interstitial.
  if (/_cf_chl_opt/i.test(html)) return true
  if (/id=["']challenge-form["']/i.test(html)) return true
  if (/orchestrate\/chl_page/i.test(html)) return true
  // CF firewall/WAF deny page (error 1020 and friends) — static "blocked" page, not a
  // solvable JS challenge, but still needs to be recognized as CF so the orchestrator
  // reports tier failure and escalates instead of returning the block page as content
  if (/id="cf-error-details"/i.test(html)) return true
  if (/you have been blocked/i.test(html)) return true
  // Lean CF challenge stub — blank title/body, just the challenge-platform bootstrap
  // script. No human-readable text at all, so none of the checks above catch it.
  //
  // CAUTION: __CF$cv$params is NOT exclusive to active challenges — Cloudflare injects
  // the same bootstrap into countless ordinary, fully-rendered pages as passive
  // bot-management telemetry. Matching on the marker alone flags real pages as blocked.
  // The actual challenge stub is always near-empty (nothing else can render before the
  // challenge resolves), so gate on page size too.
  if (html.length < 3000 && /__CF\$cv\$params|\/cdn-cgi\/challenge-platform\/[^"']*jsd\/main\.js/i.test(html))
    return true
  return false
}

// Firefox's own internal about:neterror / about:certerror page — means the browser never
// reached a real server at all (DNS failure, connection refused, TLS error, etc). Distinct
// from a Cloudflare/WAF block: there's no origin response to retry against, so callers
// should treat this the same as a hard network failure, not as scraped content.
export function isBrowserErrorPage(html: string): boolean {
  if (/chrome:\/\/global\/skin\/aboutNetError/i.test(html)) return true
  if (/data-l10n-id="(neterror|certerror)-page-title"/i.test(html)) return true
  if (/<net-error-card>/i.test(html)) return true
  return false
}

export function hasTurnstile(html: string): boolean {
  return (
    /class="cf-turnstile"/i.test(html) ||
    /challenges\.cloudflare\.com\/turnstile/i.test(html) ||
    /cdn-cgi\/challenge-platform[^"']*turnstile/i.test(html)
  )
}

export function hasHcaptcha(html: string): boolean {
  return /class="h-captcha"|hcaptcha\.com\/1\/api/i.test(html)
}

export function hasRecaptcha(html: string): boolean {
  return /class="g-recaptcha"|google\.com\/recaptcha|recaptcha\.net\/recaptcha/i.test(html)
}

export function hasCapChallenge(html: string): boolean {
  return /cap-widget|trycap\.dev|data-cap-/i.test(html)
}

// Imperva/Incapsula WAF challenge — sensor-based (reese84, current) or legacy (___utmvc).
// Both are produced by an obfuscated in-page JS challenge; no need to understand the
// obfuscation, just detect the challenge page and wait for the sensor cookie (see impervaWait.ts).
export function hasImpervaChallenge(html: string, headers: Record<string, string> = {}): boolean {
  const lowerHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v
  if (lowerHeaders["x-iinfo"]) return true
  if (/incapsula/i.test(lowerHeaders["x-cdn"] ?? "")) return true
  if (/incapsula incident id/i.test(html)) return true
  if (/_incapsula_resource/i.test(html)) return true
  if (/visid_incap_|incap_ses_|nlbi_|reese84|___utmvc/i.test(html)) return true
  return false
}

// Akamai Bot Manager "Behavioral Detection" (sec-cpt / SBSD) interstitial. Akamai
// serves a near-empty page whose only real content is a hidden #sec-if-cpt-container
// (the "behavioral-content" widget, often a press-and-hold button) plus an obfuscated
// sensor script; once the sensor's XHR posts telemetry the page location.reload()s
// into the real content. trawl solves this by driving human-like interaction and
// waiting for the reload — see akamaiWait.ts. These DOM markers are challenge-only
// (the class/id names don't appear on ordinary Akamai-fronted pages), so no size gate
// is needed for them; the sensor-bootstrap fallback IS size-gated to avoid flagging
// full pages that merely carry passive Akamai telemetry.
export function hasAkamaiChallenge(html: string, _headers: Record<string, string> = {}): boolean {
  if (/id=["']?sec-if-cpt-container|class=["'][^"']*behavioral-content|sec-bc-tile|scf-akamai-logo/i.test(html))
    return true
  if (/\/_sec\/(cp_challenge|verify)\//i.test(html)) return true
  if (html.length < 3500 && /akamai\.com/i.test(html) && /(progress-button|behavioral|sec-cpt)/i.test(html)) return true
  return false
}

// DDoS-Guard's JS interstitial markers. The provider's generic Server header and
// bare domain mentions are intentionally excluded because ordinary protected pages
// contain them too.
export function hasDdosGuardChallenge(html: string, _headers: Record<string, string> = {}): boolean {
  if (/\/\.well-known\/ddos-guard\/js-challenge\//i.test(html)) return true
  if (/id=["']ddg-l10n-(title|description)["']|id=["']ddg-img-loading["']/i.test(html)) return true
  if (/check\.ddos-guard\.net\/check\.js/i.test(html)) return true
  return false
}

// AWS WAF JavaScript challenge — the interstitial page that loads challenge.js to
// issue an aws-waf-token cookie before redirecting to the protected resource.
export function hasAwsWafChallenge(html: string, headers: Record<string, string> = {}, status?: number): boolean {
  if (getAwsWafAction(status, headers) === "challenge") return true
  return /window\.gokuProps/i.test(html) && /token\.awswaf\.com\/[^"']*challenge\.js/i.test(html)
}

export function hasAwsWafCaptcha(html: string, headers: Record<string, string> = {}, status?: number): boolean {
  if (getAwsWafAction(status, headers) === "captcha") return true
  return /window\.gokuProps/i.test(html) && /token\.awswaf\.com\/[^"']*captcha\.js/i.test(html)
}

// DataDome serves every wall through captcha-delivery.com. The domain is exclusive to the
// product, and the inline `dd` object plus the two challenge scripts separate the variants:
// i.js is the passive Device Check, c.js the interactive slider.
//
// CAUTION: the `js.datadome.co/tags.js` client tag is NOT a marker. Protected sites ship
// it on every ordinary page as passive telemetry, the same trap as Cloudflare's
// __CF$cv$params. A bare captcha-delivery.com mention is not enough either: only the
// challenge paths and the `dd` object count.
export type DataDomeAction = "interstitial" | "captcha" | "blocked"

// Read the fields out of a window that starts at the object, rather than capturing up to
// the first `}`: a nested object would truncate the capture and hide `t`. `rt` and `t` sit
// in the first few fields of every observed block page, well inside the window.
const DD_OBJECT = /\bdd\s*=\s*\{/i
const DD_WINDOW = 600
const DD_RT = /["']rt["']\s*:\s*["']([^"']*)["']/i
const DD_T = /["']t["']\s*:\s*["']([^"']*)["']/i

export function getDataDomeAction(
  html: string,
  headers: Record<string, string> = {},
  _status?: number,
): DataDomeAction | undefined {
  if (/captcha-delivery\.com/i.test(html)) {
    const ddAt = html.match(DD_OBJECT)?.index
    const dd = ddAt === undefined ? undefined : html.slice(ddAt, ddAt + DD_WINDOW)
    // `t=bv` is DataDome's hard block ("Access denied"). No widget clears it, only a
    // different egress IP does, so it must not be waited on like a solvable challenge.
    // It reaches us two ways: a field of the inline `dd` object on an HTML block page,
    // or a query parameter on the challenge URL of a JSON block.
    if (dd?.match(DD_T)?.[1]?.toLowerCase() === "bv" || /[?&]t=bv\b/i.test(html)) return "blocked"
    // `rt` is the variant DataDome itself declares, so it outranks the script guesses below.
    const rt = dd?.match(DD_RT)?.[1]?.toLowerCase()
    if (rt === "i") return "interstitial"
    if (rt === "c") return "captcha"
    if (/\/interstitial\//i.test(html) || /src=["'][^"']*\/i\.js/i.test(html)) return "interstitial"
    if (/\/captcha\//i.test(html) || /src=["'][^"']*\/c\.js/i.test(html)) return "captcha"
  }
  // Header-only fallback: x-dd-b appears ONLY on the responses DataDome generates itself
  // (observed values 1, 2 and 3, all on blocks). The proxy path inspects headers before
  // the body arrives, so the variant is still unknown here: escalate to a browser, which
  // reclassifies from the page.
  //
  // DO NOT widen this to `x-datadome`. That header reads `protected` on every ordinary
  // page of a protected site, and isChallengeWall() below trusts a "datadome" verdict
  // unconditionally, so widening it turns every good page into a wall. `x-datadome-cid`
  // is block-only like x-dd-b and is the one safe second signal if you ever need it.
  if (headerValue(headers, "x-dd-b") !== undefined) return "interstitial"
  return undefined
}

export function hasDataDomeChallenge(html: string, headers: Record<string, string> = {}, status?: number): boolean {
  return getDataDomeAction(html, headers, status) !== undefined
}

export function hasDataDomeCaptcha(html: string, headers: Record<string, string> = {}, status?: number): boolean {
  return getDataDomeAction(html, headers, status) === "captcha"
}

export function detectChallengeType(
  html: string,
  headers: Record<string, string> = {},
  status?: number,
): ChallengeType {
  if (hasAwsWafChallenge(html, headers, status) || hasAwsWafCaptcha(html, headers, status)) return "aws-waf"
  if (hasCloudflareChallengeHeader(headers)) return "cloudflare-interstitial"
  if (hasDataDomeChallenge(html, headers, status)) return "datadome"
  if (hasTurnstile(html)) return "cloudflare-turnstile"
  if (hasDdosGuardChallenge(html, headers)) return "ddos-guard"
  if (isCloudflarePage(html, headers)) return "cloudflare-interstitial"
  if (hasImpervaChallenge(html, headers)) return "imperva"
  if (hasAkamaiChallenge(html, headers)) return "akamai"
  if (hasHcaptcha(html)) return "hcaptcha"
  if (hasRecaptcha(html)) return "recaptcha"
  if (hasCapChallenge(html)) return "cap"
  return "none"
}

export function isBlocked(status: number, html: string): boolean {
  if (status === 403 || status === 429) return true
  if (isCloudflarePage(html, {})) return true
  if (hasImpervaChallenge(html)) return true
  if (hasAkamaiChallenge(html)) return true
  if (hasDdosGuardChallenge(html)) return true
  if (hasDataDomeChallenge(html)) return true
  return false
}

export function needsJs(html: string, headers: Record<string, string>): boolean {
  return (
    isCloudflarePage(html, headers) ||
    hasImpervaChallenge(html, headers) ||
    hasAkamaiChallenge(html, headers) ||
    hasDdosGuardChallenge(html, headers) ||
    hasDataDomeChallenge(html, headers)
  )
}

// Lean-body threshold per challenge type. When a known challenge returns a response
// with body shorter than this, the page is wall-graded (only the bootstrap script
// loaded, no real content yet). Absent = the challenge is never wall-graded by
// body length alone (relies on 4xx/5xx instead).
const LEAN_BODY_THRESHOLDS: Partial<Record<ChallengeType, number>> = {
  "cloudflare-interstitial": 3000,
  imperva: 5000,
  "ddos-guard": 3000,
}

// True if the response is a challenge wall (page access blocked) rather than a page
// that happens to contain a captcha widget. 4xx/5xx is HTTP-standard; the lean-stub
// checks are TRAWL-specific heuristics (CF's auto-resolving bootstrap and Imperva's
// sensor cookie challenge can come at 200 with body < a few KB).
export function isChallengeWall(status: number, bodyLength: number, challengeType: ChallengeType): boolean {
  if (challengeType === "none") return false
  if (status === 403 || status === 503) return true
  // These three never serve real content alongside their wall, so the type alone settles
  // it. For datadome that leans on the header invariant documented in getDataDomeAction().
  if (challengeType === "akamai" || challengeType === "aws-waf" || challengeType === "datadome") return true
  const threshold = LEAN_BODY_THRESHOLDS[challengeType]
  if (threshold !== undefined && bodyLength < threshold) return true
  return false
}
