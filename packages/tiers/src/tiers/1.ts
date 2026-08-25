import { FINGERPRINT } from "@trawl/browser"
import type { TierResult } from "@trawl/types"
import {
  getAwsWafAction,
  getDataDomeAction,
  hasAkamaiChallenge,
  hasAwsWafCaptcha,
  hasAwsWafChallenge,
  hasHcaptcha,
  hasRecaptcha,
  hasTurnstile,
  isBlocked,
  isCloudflarePage,
} from "../utils/detect"
import { normalizeHtml } from "../utils/html"
import { isTextContentType } from "../utils/response"

export interface Tier1Result extends TierResult {
  tier: 1
  effectiveUrl?: string
  html?: string
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
  statusCode?: number
}

// Methods that may carry a request body per RFC 7231/9341. CONNECT is excluded
// (tunneling verb), TRACE/GET/HEAD/OPTIONS excluded (no body semantics).
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE", "QUERY"])

export async function runTier1(
  url: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
): Promise<Tier1Result> {
  const start = Date.now()
  try {
    const m = (method ?? "GET").toUpperCase()
    const res = await fetch(url, {
      method: m,
      body: METHODS_WITH_BODY.has(m) ? body : undefined,
      headers: {
        "User-Agent": FINGERPRINT.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        ...extraHeaders,
      },
      redirect: "follow",
    })

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
    const awsAction = getAwsWafAction(res.status, responseHeaders)
    if (awsAction) {
      return {
        tier: 1,
        status: awsAction === "captcha" ? "blocked" : "needs-js",
        durationMs: Date.now() - start,
        reason: awsAction === "captcha" ? "aws-waf-captcha-required" : "aws-waf-challenge",
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
    // so detection helpers don't throw on non-UTF8 payloads.
    const previewLen = Math.min(rawBytes.length, 4096)
    const previewText = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes.subarray(0, previewLen))

    if (isCloudflarePage(previewText, responseHeaders)) {
      return {
        tier: 1,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "cloudflare-challenge",
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
      // is binary via the contentType field. `previewText` is bounded to 4 KiB for
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
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
