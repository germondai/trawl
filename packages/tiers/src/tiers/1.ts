import { FINGERPRINT } from "@trawl/browser"
import type { TierResult } from "@trawl/types"
import { describeCertificateError, isCertificateError } from "../utils/certificate"
import type { ChallengeType } from "../utils/detect"
import {
  getAwsWafAction,
  getDataDomeAction,
  hasAkamaiChallenge,
  hasAltcha,
  hasAwsWafCaptcha,
  hasAwsWafChallenge,
  hasDuckDuckGoChallenge,
  hasFriendlyCaptcha,
  hasHcaptcha,
  hasRecaptcha,
  hasTurnstile,
  isBlocked,
  isCloudflarePage,
} from "../utils/detect"
import { normalizeHtml } from "../utils/html"
import type { OutboundUrlValidator } from "../utils/outboundPolicy"
import { normalizeProxyError, proxyResponseFailure } from "../utils/proxyFailure"
import { isTextContentType } from "../utils/response"

export interface Tier1Result extends TierResult {
  tier: 1
  // The wall Tier 1 recognized, when it recognized one. The orchestrator routes the
  // browser it acquires for the later tiers on this: DataDome needs a headful one.
  challenge?: ChallengeType
  effectiveUrl?: string
  html?: string
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
  statusCode?: number
  // Why the origin's certificate failed verification. Set on the failed verified attempt,
  // and carried onto the unverified retry's result so the fact survives the retry.
  certificateError?: string
}

// Methods that may carry a request body per RFC 7231/9341. CONNECT is excluded
// (tunneling verb), TRACE/GET/HEAD/OPTIONS excluded (no body semantics).
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE", "QUERY"])

// One HTTP attempt. `insecure` disables TLS verification for this attempt only — runTier1
// owns the decision to make one, never the caller's headers or the environment.
async function attemptTier1(
  url: string,
  extraHeaders: Record<string, string> | undefined,
  method: string | undefined,
  body: string | undefined,
  proxy: string | undefined,
  validateOutboundUrl: OutboundUrlValidator | undefined,
  insecure: boolean,
): Promise<Tier1Result> {
  const start = Date.now()
  try {
    const m = (method ?? "GET").toUpperCase()
    const headers = {
      "User-Agent": FINGERPRINT.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...extraHeaders,
    }
    let currentUrl = url
    let currentMethod = m
    let currentBody = METHODS_WITH_BODY.has(m) ? body : undefined
    let res: Response
    for (let redirects = 0; ; redirects++) {
      await validateOutboundUrl?.(currentUrl)
      res = await fetch(currentUrl, {
        method: currentMethod,
        body: currentBody,
        headers,
        redirect: validateOutboundUrl ? "manual" : "follow",
        ...(proxy ? { proxy } : {}),
        ...(insecure ? { tls: { rejectUnauthorized: false } } : {}),
      })
      if (!validateOutboundUrl || ![301, 302, 303, 307, 308].includes(res.status)) break
      const location = res.headers.get("location")
      if (!location) break
      if (redirects >= 9) throw new Error("Too many redirects")
      await res.body?.cancel()
      currentUrl = new URL(location, currentUrl).href
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
        currentMethod = "GET"
        currentBody = undefined
      }
    }

    // AWS WAF's action header is authoritative when paired with its documented
    // status. Inspect it before reading the body: challenge responses may keep the
    // body open, and waiting for arrayBuffer() would delay browser escalation.
    const responseHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v
    })
    const setCookies = res.headers.getSetCookie()
    if (setCookies.length > 0) responseHeaders["set-cookie"] = setCookies.join("\n")
    const contentType = responseHeaders["content-type"] ?? "application/octet-stream"
    const proxyFailure = proxy ? proxyResponseFailure(res.status, responseHeaders) : undefined
    if (proxyFailure) {
      return {
        tier: 1,
        status: "error",
        durationMs: Date.now() - start,
        reason: proxyFailure,
        responseHeaders,
        contentType,
        body: new Uint8Array(),
        statusCode: res.status,
      }
    }
    const awsAction = getAwsWafAction(res.status, responseHeaders)
    if (awsAction) {
      return {
        tier: 1,
        status: awsAction === "captcha" ? "blocked" : "needs-js",
        durationMs: Date.now() - start,
        reason: awsAction === "captcha" ? "aws-waf-captcha-required" : "aws-waf-challenge",
        challenge: "aws-waf",
        responseHeaders,
        contentType,
        body: new Uint8Array(),
        statusCode: res.status,
      }
    }

    // Preserve raw bytes — required for binary content (.torrent, images, etc.).
    // The MITM proxy (:8192) consumes `body`; /scrape still consumes `html`.
    const rawBytes = new Uint8Array(await res.arrayBuffer())

    // Decode a bounded preview losslessly for challenge detection — keeps the original
    // byte buffer untouched. `fatal: false` replaces invalid sequences with U+FFFD
    // so detection helpers don't throw on non-UTF8 payloads. 64 KiB covers deep head
    // and script tags in dynamic challenge pages (e.g. ALTCHA / PoW widgets).
    const previewLen = Math.min(rawBytes.length, 65536)
    const previewText = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes.subarray(0, previewLen))

    if (isCloudflarePage(previewText, responseHeaders)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "cloudflare-challenge",
        challenge: "cloudflare-interstitial",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }

    if (hasDuckDuckGoChallenge(previewText, responseHeaders)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "duckduckgo-anomaly-challenge",
        challenge: "duckduckgo",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }

    // JS-only challenges: the page's static HTML is just a shell that loads the
    // captcha widget via <script src="...api.js">. Plain fetch sees the shell and
    // would otherwise report success — but the real content (including the widget)
    // only renders after JS executes. Escalate so Tier 3 runs the page in a browser,
    // executes JS, and the solver can engage the actual widget.
    if (hasHcaptcha(previewText)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "hcaptcha-shell",
        challenge: "hcaptcha",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }
    if (hasRecaptcha(previewText)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "recaptcha-shell",
        challenge: "recaptcha",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }
    if (hasTurnstile(previewText)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "turnstile-shell",
        challenge: "cloudflare-turnstile",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }
    if (hasAltcha(previewText)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "altcha-shell",
        challenge: "altcha",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }
    if (hasFriendlyCaptcha(previewText)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "friendly-captcha-shell",
        challenge: "friendly-captcha",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }
    if (hasAkamaiChallenge(previewText, responseHeaders)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "akamai-interstitial",
        challenge: "akamai",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }
    if (hasAwsWafCaptcha(previewText, responseHeaders, res.status)) {
      return {
        tier: 1,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "aws-waf-captcha-required",
        challenge: "aws-waf",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }
    if (hasAwsWafChallenge(previewText, responseHeaders, res.status)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "aws-waf-challenge",
        challenge: "aws-waf",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }

    // DataDome answers with 403 for every wall, so this must run before the generic
    // isBlocked() check: only the Device Check is worth a browser, the slider and the
    // hard block are not.
    const dataDomeAction = getDataDomeAction(previewText, responseHeaders, res.status)
    if (dataDomeAction) {
      return {
        tier: 1,
        status: dataDomeAction === "interstitial" ? "needs-js" : "blocked",
        durationMs: Date.now() - start,
        reason:
          dataDomeAction === "interstitial"
            ? "datadome-interstitial"
            : dataDomeAction === "captcha"
              ? "datadome-captcha-required"
              : "datadome-blocked",
        challenge: "datadome",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }

    if (isBlocked(res.status, previewText)) {
      return {
        tier: 1,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: `http-${res.status}`,
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }

    return {
      tier: 1,
      status: "success",
      durationMs: Date.now() - start,
      effectiveUrl: res.url,
      // `html` is best-effort text view of the body — only meaningful for text-like
      // content-types. Empty for binary payloads so /scrape consumers see the body
      // is binary via the contentType field. `previewText` is bounded to 64 KiB for
      // challenge detection and must not be used as the response body — decode the
      // full buffer, reusing the preview only when it already covers the whole body.
      html: isTextContentType(contentType)
        ? normalizeHtml(
            rawBytes.length > previewLen ? new TextDecoder("utf-8", { fatal: false }).decode(rawBytes) : previewText,
          )
        : "",
      body: rawBytes,
      responseHeaders,
      contentType,
      statusCode: res.status,
    }
  } catch (err) {
    return {
      tier: 1,
      status: "error",
      durationMs: Date.now() - start,
      reason: proxy ? normalizeProxyError(err) : err instanceof Error ? err.message : String(err),
      certificateError: isCertificateError(err) ? describeCertificateError(err) : undefined,
    }
  }
}

export async function runTier1(
  url: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
  proxy?: string,
  validateOutboundUrl?: OutboundUrlValidator,
  ignoreCertificateErrors?: boolean,
): Promise<Tier1Result> {
  const verified = await attemptTier1(url, extraHeaders, method, body, proxy, validateOutboundUrl, false)
  if (!ignoreCertificateErrors || verified.certificateError === undefined) return verified

  // The verified attempt is the only place the bad certificate is ever observed: retry it
  // unverified and the connection succeeds with nothing to report, so keep the reason from
  // the attempt that failed and hand it to the caller alongside the page.
  const unverified = await attemptTier1(url, extraHeaders, method, body, proxy, validateOutboundUrl, true)
  return {
    ...unverified,
    durationMs: verified.durationMs + unverified.durationMs,
    certificateError: verified.certificateError,
  }
}
