import { rootCertificates } from "node:tls"
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib"
import { FINGERPRINT } from "@trawl/browser"
import type { TierResult } from "@trawl/types"
import { anubisInspectionText, detectAnubisPage } from "../utils/anubis"
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
import { isGoogleSorryUrl } from "../utils/googleSorry"
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
  // Why a TLS hop's certificate failed verification. Carried onto the unverified
  // retry's result so the fact survives the retry.
  certificateError?: string
}

// Methods that may carry a request body per RFC 7231/9341. CONNECT is excluded
// (tunneling verb), TRACE/GET/HEAD/OPTIONS excluded (no body semantics).
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE", "QUERY"])

const decodeResponseBody = (body: Uint8Array, contentEncoding?: string): Uint8Array => {
  const encodings = (contentEncoding ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding.length > 0 && encoding !== "identity")

  if (encodings.length === 0) return body

  try {
    let decoded = Buffer.from(body)
    for (const encoding of encodings.reverse()) {
      if (encoding === "gzip" || encoding === "x-gzip") decoded = gunzipSync(decoded)
      else if (encoding === "deflate") decoded = inflateSync(decoded)
      else if (encoding === "br") decoded = brotliDecompressSync(decoded)
      else if (encoding === "zstd") decoded = zstdDecompressSync(decoded)
      else return body
    }
    return decoded
  } catch {
    // Challenge inspection is best effort. Keep the original representation
    // intact when an upstream sends malformed or unsupported encoded bytes.
    return body
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
  trustedProxyCa?: string,
): Promise<Tier1Result> {
  const start = Date.now()
  let certificateError: string | undefined
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
      const fetchHop = (insecure: boolean) =>
        fetch(currentUrl, {
          method: currentMethod,
          body: currentBody,
          headers,
          // Manual redirects let an opted-in request retry only the TLS hop that failed.
          // Restarting from the original URL could submit a successful POST twice when a
          // later redirect target has an invalid certificate.
          redirect: validateOutboundUrl || ignoreCertificateErrors ? "manual" : "follow",
          // Tier 1 feeds the MITM proxy, so its body must keep the same encoded
          // representation described by Content-Encoding, validators, and ranges.
          decompress: false,
          ...(proxy ? { proxy } : {}),
          ...(trustedProxyCa ? { tls: { ca: [...rootCertificates, trustedProxyCa] } } : {}),
          ...(insecure ? { tls: { rejectUnauthorized: false } } : {}),
        })

      try {
        res = await fetchHop(false)
      } catch (err) {
        if (!ignoreCertificateErrors || !isCertificateError(err)) throw err
        certificateError ??= describeCertificateError(err)
        res = await fetchHop(true)
      }

      if (!(validateOutboundUrl || ignoreCertificateErrors) || ![301, 302, 303, 307, 308].includes(res.status)) {
        break
      }
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
        certificateError,
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
        certificateError,
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

    // Preserve encoded representation bytes for the MITM proxy and binary
    // content. Decode a separate view for challenge inspection and `/scrape`'s
    // text-only `html` field without invalidating the upstream response headers.
    const rawBytes = new Uint8Array(await res.arrayBuffer())
    const decodedBytes = decodeResponseBody(rawBytes, responseHeaders["content-encoding"])

    // Decode a bounded text preview losslessly. `fatal: false` replaces invalid
    // sequences with U+FFFD so detection helpers don't throw on non-UTF8 data.
    const previewLen = Math.min(decodedBytes.length, 65536)
    const previewText = new TextDecoder("utf-8", { fatal: false }).decode(decodedBytes.subarray(0, previewLen))

    const anubis = detectAnubisPage(anubisInspectionText(decodedBytes, previewText))
    if (anubis) {
      return {
        tier: 1,
        certificateError,
        status: anubis === "blocked" ? "blocked" : "needs-js",
        durationMs: Date.now() - start,
        reason: anubis === "blocked" ? "anubis-blocked" : "anubis-challenge",
        challenge: "anubis",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }

    if (isGoogleSorryUrl(res.url || currentUrl)) {
      return {
        tier: 1,
        certificateError,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "google-sorry-challenge",
        challenge: "recaptcha",
        responseHeaders,
        contentType,
        body: rawBytes,
        statusCode: res.status,
      }
    }

    if (isCloudflarePage(previewText, responseHeaders)) {
      return {
        tier: 1,
        certificateError,
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
        certificateError,
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
        certificateError,
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
        certificateError,
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
        certificateError,
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
        certificateError,
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
        certificateError,
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
        certificateError,
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
        certificateError,
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
        certificateError,
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
        certificateError,
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
        certificateError,
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
      certificateError,
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
            decodedBytes.length > previewLen
              ? new TextDecoder("utf-8", { fatal: false }).decode(decodedBytes)
              : previewText,
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
      certificateError: certificateError ?? (isCertificateError(err) ? describeCertificateError(err) : undefined),
    }
  }
}
