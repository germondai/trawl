import { parseHTML } from "linkedom"
import { detectAnubisPage } from "./anubis"

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
  | "duckduckgo"
  | "anubis"
  | "altcha"
  | "friendly-captcha"
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
  if (hasDuckDuckGoChallenge(html) || hasAnubisChallenge(html)) return false
  if (hasAltcha(html) || hasFriendlyCaptcha(html)) return false
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
  // CF firewall/WAF deny page (error 1020 and friends) - static "blocked" page, not a
  // solvable JS challenge, but still needs to be recognized as CF so the orchestrator
  // reports tier failure and escalates instead of returning the block page as content
  if (/id="cf-error-details"/i.test(html)) return true
  if (/you have been blocked/i.test(html)) return true
  // Lean CF challenge stub - blank title/body, just the challenge-platform bootstrap
  // script. No human-readable text at all, so none of the checks above catch it.
  //
  // CAUTION: __CF$cv$params is NOT exclusive to active challenges - Cloudflare injects
  // the same bootstrap into countless ordinary, fully-rendered pages as passive
  // bot-management telemetry. Matching on the marker alone flags real pages as blocked.
  // The actual challenge stub is always near-empty (nothing else can render before the
  // challenge resolves), so gate on page size too.
  if (html.length < 3000 && /__CF\$cv\$params|\/cdn-cgi\/challenge-platform\/[^"']*jsd\/main\.js/i.test(html))
    return true
  return false
}

// Firefox's own internal about:neterror / about:certerror page - means the browser never
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
  return /<cap-widget(?=[\s/>])/i.test(html)
}

// ALTCHA is a Web Component. Restrict static detection to the component, its
// generated form field, or its widget script; the brand name and generic PoW
// wording also occur in ordinary articles and integration documentation.
export function hasAltcha(html: string): boolean {
  return (
    /<altcha-widget\b/i.test(html) ||
    /<input\b[^>]*\bname\s*=\s*["']altcha["']/i.test(html) ||
    /<script\b[^>]*\baltcha(?:[-_]widget)?(?:\.min)?\.[cm]?js\b/i.test(html)
  )
}

// Friendly Captcha v1/v2 mount under .frc-captcha and publish one of these two
// managed form fields. A provider iframe is only meaningful when its URL is a
// widget path; a bare friendlycaptcha/frcapi mention is not enough.
export function hasFriendlyCaptcha(html: string): boolean {
  if (/<[^>]+\bclass\s*=\s*["'][^"']*\bfrc-captcha\b[^"']*["']/i.test(html)) return true
  if (/<input\b[^>]*\bname\s*=\s*["']frc-captcha-(?:solution|response)["']/i.test(html)) return true
  return /<iframe\b[^>]*\bsrc\s*=\s*["'][^"']*(?:frcapi\.com|friendlycaptcha\.[^/"']+)[^"']*\/(?:captcha\/)?widget\b/i.test(
    html,
  )
}

// CDN identity and cookie names can appear on ordinary pages and in documentation.
// Require an active resource frame, a sensor-only shell, or an Imperva error response.
export function hasImpervaChallenge(html: string, headers: Record<string, string> = {}, status?: number): boolean {
  const fromImperva = Boolean(headerValue(headers, "x-iinfo")) || /incapsula/i.test(headerValue(headers, "x-cdn") ?? "")
  if (fromImperva && (status === 403 || status === 429 || status === 503)) return true
  if (
    /<title[^>]*>\s*Pardon Our Interruption\s*<\/title>/i.test(html) &&
    /something about your browser made us think you were a bot|pardon our interruption[^<]*imperva/i.test(html)
  )
    return true
  if (!/_incapsula_resource|reese84|___utmvc|visid_incap_|incap_ses_|nlbi_|incapsula incident id/i.test(html))
    return false

  const { document } = parseHTML(html)
  const attribute = (element: Element, name: string): string | undefined =>
    Array.from(element.attributes).find((attr) => attr.name.toLowerCase() === name)?.value
  const isResource = (src: string | undefined): boolean => {
    if (!src) return false
    try {
      const url = new URL(src, "https://example.test/")
      return /^https?:$/.test(url.protocol) && /(?:^|\/)_incapsula_resource(?:\/|$)/i.test(url.pathname)
    } catch {
      return false
    }
  }
  const isActive = (element: Element): boolean => !element.closest("template, noscript")
  for (const frame of document.querySelectorAll("iframe")) {
    if (isActive(frame) && isResource(attribute(frame, "src"))) return true
  }

  if (
    /^(?:request unsuccessful|access denied)\b/i.test((document.querySelector("title")?.textContent ?? "").trim()) &&
    /incapsula incident id\s*:\s*\d/i.test(document.querySelector("body")?.textContent ?? "")
  )
    return true

  const scripts = [...document.querySelectorAll("script")].filter((script) => {
    const type = attribute(script, "type")?.trim().toLowerCase()
    return isActive(script) && (!type || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/.test(type))
  })
  const hasSensor = scripts.some((script) => {
    if (isResource(attribute(script, "src"))) return true
    const code = script.textContent ?? ""
    return (
      /\b(?:window\.)?reese84\s*=/i.test(code) ||
      (/\bdocument\.cookie\s*=/i.test(code) && /reese84|___utmvc|visid_incap_|incap_ses_|nlbi_/i.test(code))
    )
  })
  if (!hasSensor) return false
  if (hasChallengeWallMarkers(html)) return true

  // Script size varies with obfuscation; visible content distinguishes a bootstrap
  // from an article that carries a passive sensor. Never execute the parsed scripts.
  for (const element of document.querySelectorAll("head, script, style, template, noscript")) element.remove()
  const text = document.documentElement?.textContent ?? ""
  return text.replace(/\s+/g, " ").trim().length < 200
}

// Akamai Bot Manager "Behavioral Detection" (sec-cpt / SBSD) interstitial. Akamai
// serves a near-empty page whose only real content is a hidden #sec-if-cpt-container
// (the "behavioral-content" widget, often a press-and-hold button) plus an obfuscated
// sensor script; once the sensor's XHR posts telemetry the page location.reload()s
// into the real content. trawl solves this by driving human-like interaction and
// waiting for the reload - see akamaiWait.ts. These DOM markers are challenge-only
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

// DuckDuckGo's anomaly wall is an interactive image CAPTCHA. Require either its
// provider-owned endpoint or all of the structural fallback markers: each generic
// marker can occur independently in application pages and test fixtures.
export function hasDuckDuckGoChallenge(html: string, _headers: Record<string, string> = {}): boolean {
  const providerEndpoint = /(?:action|src)=["'](?:https?:)?\/\/(?:html\.)?duckduckgo\.com\/anomaly\.js(?:[?"'])/i.test(
    html,
  )
  if (providerEndpoint) return true

  const anomalyEndpoint = /(?:action|src)=["'][^"']*\/anomaly\.js(?:[?"'])/i.test(html)
  const challengeForm = /id=["']challenge-form["']/i.test(html)
  const anomalyModal =
    /data-testid=["']anomaly-modal["']/i.test(html) || /class=["'][^"']*\banomaly-modal(?:\b|__)/i.test(html)
  return anomalyEndpoint && challengeForm && anomalyModal
}

// Anubis walls can return HTTP 200; inspect their challenge payload rather than status.
export function hasAnubisChallenge(html: string): boolean {
  return detectAnubisPage(html) !== undefined
}

// AWS WAF JavaScript challenge - the interstitial page that loads challenge.js to
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
  if (hasDuckDuckGoChallenge(html, headers)) return "duckduckgo"
  if (hasAnubisChallenge(html)) return "anubis"
  if (hasAltcha(html)) return "altcha"
  if (hasFriendlyCaptcha(html)) return "friendly-captcha"
  if (isCloudflarePage(html, headers)) return "cloudflare-interstitial"
  if (hasImpervaChallenge(html, headers, status)) return "imperva"
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
  if (hasDuckDuckGoChallenge(html)) return true
  if (hasAnubisChallenge(html)) return true
  return false
}

export function needsJs(html: string, headers: Record<string, string>): boolean {
  return (
    isCloudflarePage(html, headers) ||
    hasImpervaChallenge(html, headers) ||
    hasAkamaiChallenge(html, headers) ||
    hasDdosGuardChallenge(html, headers) ||
    hasDataDomeChallenge(html, headers) ||
    hasDuckDuckGoChallenge(html, headers) ||
    hasAnubisChallenge(html) ||
    hasAltcha(html) ||
    hasFriendlyCaptcha(html) ||
    hasCapChallenge(html)
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

export function hasChallengeWallMarkers(html: string): boolean {
  if (
    /<title\b[^>]*>(?:[^<]*[-|–—:]\s*)?(?:captcha|challenge|security\s*check|human\s*verification|bot\s*verification|just\s*a\s*moment|attention\s*required)\b/i.test(
      html,
    )
  ) {
    return true
  }
  if (/(?:enable\s+javascript|javascript\s+is\s+required)\s+to\s+complete\s+this\s+challenge/i.test(html)) {
    return true
  }
  return false
}

// True if the response is a challenge wall (page access blocked) rather than a page
// that happens to contain a captcha widget. 4xx/5xx is HTTP-standard; the lean-stub
// checks and interstitial markers are TRAWL-specific heuristics (CF's auto-resolving
// bootstrap, Imperva's sensor cookie, and dynamic PoW challenge pages like Mojeek can
// arrive at 200).
export function isChallengeWall(
  status: number,
  bodyLength: number,
  challengeType: ChallengeType,
  html?: string,
): boolean {
  if (challengeType === "none") return false
  if (status === 403 || status === 429 || status === 503) return true
  // These five never serve real content alongside their wall, so the type alone settles
  // it. For datadome that leans on the header invariant documented in getDataDomeAction().
  if (
    challengeType === "akamai" ||
    challengeType === "aws-waf" ||
    challengeType === "datadome" ||
    challengeType === "duckduckgo" ||
    challengeType === "anubis"
  )
    return true
  if (html && hasChallengeWallMarkers(html)) return true
  const threshold = LEAN_BODY_THRESHOLDS[challengeType]
  if (threshold !== undefined && bodyLength < threshold) return true
  return false
}
