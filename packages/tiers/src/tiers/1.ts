import { rootCertificates } from "node:tls"
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib"
import { FINGERPRINT } from "@trawl/browser"
import type { Cookie, TierResult } from "@trawl/types"
import { parseHTML } from "linkedom"
import { anubisInspectionText, detectAnubisPage } from "../utils/anubis"
import { describeCertificateError, isCertificateError } from "../utils/certificate"
import { sleep } from "../utils/deadline"
import type { ChallengeType } from "../utils/detect"
import {
  getAwsWafAction,
  getDataDomeAction,
  hasAkamaiChallenge,
  hasAltcha,
  hasAwsWafCaptcha,
  hasAwsWafChallenge,
  hasCloudflareChallengeHeader,
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
import type { HttpSessionCookies } from "../utils/httpSessionCookies"
import { cookiePairs, mergeCookieHeader, planPowWall } from "../utils/nativePow"
import type { OutboundUrlValidator } from "../utils/outboundPolicy"
import { normalizeProxyError, proxyResponseFailure } from "../utils/proxyFailure"
import { decodeTextBody, isHtmlContentType, isTextContentType } from "../utils/response"
import { tier1Transport, tier1UserAgent } from "../utils/tier1Transport"
import type { WafEvidence } from "../utils/waf"

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
  cookies?: Cookie[]
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

// Tier 1 with native proof-of-work: when the response is a PoW wall that
// utils/nativePow recognizes (NCBI identity PoW, Anubis), solve it in-process
// (Rust via bun:ffi), submit the answer, and refetch with the pass cookie. The
// result carries every Set-Cookie from the exchange, so a MITM proxy client keeps
// the pass cookie and skips the wall on its next request.
export async function runTier1(
  url: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
  proxy?: string,
  validateOutboundUrl?: OutboundUrlValidator,
  ignoreCertificateErrors?: boolean,
  trustedProxyCa?: string,
  signal?: AbortSignal,
  sessionCookies?: HttpSessionCookies,
  timeoutMs = 60_000,
  headersTimeoutMs?: number,
  observeResponse?: (evidence: WafEvidence) => void,
  networkProxy?: string,
): Promise<Tier1Result> {
  const start = Date.now()
  const once = (headers: Record<string, string> | undefined, remainingMs: number) =>
    runTier1Once(
      url,
      headers,
      method,
      body,
      proxy,
      validateOutboundUrl,
      ignoreCertificateErrors,
      trustedProxyCa,
      signal,
      sessionCookies,
      remainingMs,
      headersTimeoutMs,
      observeResponse,
      networkProxy,
    )
  const first = await once(extraHeaders, timeoutMs)
  if (!first.body || first.body.length === 0 || first.body.length > 262_144) return first
  if (!isHtmlContentType(first.contentType ?? "")) return first
  const html = new TextDecoder("utf-8", { fatal: false }).decode(
    decodeResponseBody(first.body, first.responseHeaders?.["content-encoding"]),
  )
  const plan = planPowWall(html, url)
  if (!plan) return first

  try {
    if (plan.waitMs > 0) await sleep(plan.waitMs, signal)
    const solveStart = Date.now()
    const submit = plan.submit()
    const solveMs = Date.now() - solveStart
    if (!submit) {
      console.log(`[native-pow] ${plan.kind} unsolved for ${url}`)
      return first
    }
    const cookieKey = Object.keys(extraHeaders ?? {}).find((k) => k.toLowerCase() === "cookie")
    const clientCookie = cookieKey ? extraHeaders?.[cookieKey] : undefined
    const firstCookies = cookiePairs(first.responseHeaders?.["set-cookie"])
    const submitCookie = sessionCookies
      ? sessionCookies.header(submit.url)
      : mergeCookieHeader(clientCookie, firstCookies)
    await validateOutboundUrl?.(submit.url)
    const res = await tier1Transport.fetch(submit.url, {
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - start)),
      signal,
      method: submit.method,
      body: submit.body,
      redirect: "manual",
      headers: {
        "user-agent": tier1UserAgent(FINGERPRINT.userAgent),
        accept: submit.method === "POST" ? "*/*" : "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        referer: url,
        ...(submit.method === "POST" ? { origin: new URL(url).origin } : {}),
        ...(submit.contentType ? { "content-type": submit.contentType } : {}),
        ...(submitCookie ? { cookie: submitCookie } : {}),
      },
      ...(networkProxy || proxy ? { proxy: networkProxy ?? proxy } : {}),
      ...(trustedProxyCa ? { tls: { ca: [...rootCertificates, trustedProxyCa] } } : {}),
      ...(ignoreCertificateErrors ? { tls: { rejectUnauthorized: false } } : {}),
    })
    await res.arrayBuffer().catch(() => undefined)
    sessionCookies?.update(res.headers, submit.url)
    const submitSetCookies = res.headers.getSetCookie()
    if (res.status >= 400 || submitSetCookies.length === 0) {
      console.log(`[native-pow] ${plan.kind} rejected for ${url}: HTTP ${res.status}`)
      return first
    }
    const retryHeaders: Record<string, string> = { ...extraHeaders }
    if (cookieKey) delete retryHeaders[cookieKey]
    retryHeaders.cookie = mergeCookieHeader(clientCookie, [
      ...firstCookies,
      ...cookiePairs(submitSetCookies.join("\n")),
    ])
    const second = await once(retryHeaders, Math.max(1, timeoutMs - (Date.now() - start)))
    const allSetCookies = [
      first.responseHeaders?.["set-cookie"],
      submitSetCookies.join("\n"),
      second.responseHeaders?.["set-cookie"],
    ]
      .filter((v): v is string => Boolean(v))
      .join("\n")
    if (second.responseHeaders && allSetCookies) second.responseHeaders["set-cookie"] = allSetCookies
    second.durationMs = Date.now() - start
    console.log(
      `[native-pow] ${plan.kind} solved in ${solveMs}ms, page ${second.status} in ${second.durationMs}ms for ${url}`,
    )
    return second
  } catch (err) {
    console.log(`[native-pow] ${plan.kind} failed for ${url}: ${err instanceof Error ? err.message : err}`)
    return first
  }
}

async function runTier1Once(
  url: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
  proxy?: string,
  validateOutboundUrl?: OutboundUrlValidator,
  ignoreCertificateErrors?: boolean,
  trustedProxyCa?: string,
  signal?: AbortSignal,
  sessionCookies?: HttpSessionCookies,
  timeoutMs = 60_000,
  headersTimeoutMs?: number,
  observeResponse?: (evidence: WafEvidence) => void,
  networkProxy?: string,
): Promise<Tier1Result> {
  const start = Date.now()
  const headersAbort = headersTimeoutMs === undefined ? undefined : new AbortController()
  const headersTimer = headersAbort ? setTimeout(() => headersAbort.abort(), headersTimeoutMs) : undefined
  const requestSignal = headersAbort
    ? signal
      ? AbortSignal.any([signal, headersAbort.signal])
      : headersAbort.signal
    : signal
  let certificateError: string | undefined
  try {
    const m = (method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {
      "user-agent": tier1UserAgent(FINGERPRINT.userAgent),
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "gzip, deflate, br, zstd",
      "upgrade-insecure-requests": "1",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      priority: "u=0, i",
    }
    // Replace defaults case-insensitively; fetch combines differently cased keys.
    for (const [name, value] of Object.entries(extraHeaders ?? {})) {
      headers[name.toLowerCase()] = value
    }
    let currentUrl = url
    let currentMethod = m
    let currentBody = METHODS_WITH_BODY.has(m) ? body : undefined
    let res: Response
    for (let redirects = 0; ; redirects++) {
      await validateOutboundUrl?.(currentUrl)
      const fetchHop = (insecure: boolean) =>
        tier1Transport.fetch(currentUrl, {
          timeoutMs: timeoutMs - (Date.now() - start),
          signal: requestSignal,
          method: currentMethod,
          body: currentBody,
          headers: sessionCookies ? { ...headers, cookie: sessionCookies.header(currentUrl) } : headers,
          // Manual redirects let an opted-in request retry only the TLS hop that failed.
          // Restarting from the original URL could submit a successful POST twice when a
          // later redirect target has an invalid certificate.
          redirect: "manual",
          // Tier 1 feeds the MITM proxy, so its body must keep the same encoded
          // representation described by Content-Encoding, validators, and ranges.
          decompress: false,
          ...(networkProxy || proxy ? { proxy: networkProxy ?? proxy } : {}),
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

      try {
        sessionCookies?.update(res.headers, currentUrl)
      } catch (error) {
        await res.body?.cancel()
        throw error
      }
      if (![301, 302, 303, 307, 308].includes(res.status)) {
        break
      }
      const location = res.headers.get("location")
      if (!location) break
      if (redirects >= (validateOutboundUrl || ignoreCertificateErrors || sessionCookies ? 9 : 19))
        throw new Error("Too many redirects")
      await res.body?.cancel()
      const nextUrl = new URL(location, currentUrl)
      if (nextUrl.origin !== new URL(currentUrl).origin) {
        for (const name of ["authorization", "cookie", "proxy-authorization", "host"]) delete headers[name]
      }
      currentUrl = nextUrl.href
      if (
        (res.status === 303 && currentMethod !== "HEAD") ||
        ((res.status === 301 || res.status === 302) && currentMethod === "POST")
      ) {
        currentMethod = "GET"
        currentBody = undefined
        for (const name of [
          "content-type",
          "content-length",
          "content-encoding",
          "content-language",
          "content-location",
        ])
          delete headers[name]
      }
    }

    clearTimeout(headersTimer)

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
    const proxyFailure = proxy || networkProxy ? proxyResponseFailure(res.status, responseHeaders) : undefined
    if (proxyFailure) {
      observeResponse?.({ statusCode: res.status, reasonPhrase: res.statusText, responseHeaders })
      await res.body?.cancel().catch(() => {})
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
      observeResponse?.({ statusCode: res.status, reasonPhrase: res.statusText, responseHeaders })
      await res.body?.cancel().catch(() => {})
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

    if (hasCloudflareChallengeHeader(responseHeaders)) {
      observeResponse?.({ statusCode: res.status, reasonPhrase: res.statusText, responseHeaders })
      await res.body?.cancel().catch(() => {})
      return {
        tier: 1,
        certificateError,
        status: "needs-js",
        durationMs: Date.now() - start,
        reason: "cloudflare-challenge",
        challenge: "cloudflare-interstitial",
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
    observeResponse?.({
      statusCode: res.status,
      reasonPhrase: res.statusText,
      responseHeaders,
      html: m === "HEAD" ? undefined : previewText,
      htmlTruncated: previewLen < decodedBytes.length,
    })

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
    // would otherwise report success - but the real content (including the widget)
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

    if (sessionCookies && m !== "HEAD" && isHtmlContentType(contentType) && /<script\b/i.test(previewText)) {
      const { document } = parseHTML(new TextDecoder().decode(decodedBytes))
      for (const node of document.querySelectorAll("head, script, style, template, noscript, svg")) node.remove()
      const text = (document.body?.textContent ?? "").replace(/\s+/g, " ").trim()
      if (!text || /^loading[.\s]*$/i.test(text)) {
        return { tier: 1, status: "needs-js", durationMs: Date.now() - start, reason: "javascript-shell" }
      }
    }

    return {
      tier: 1,
      certificateError,
      status: "success",
      durationMs: Date.now() - start,
      effectiveUrl: res.url,
      ...(sessionCookies ? { cookies: sessionCookies.snapshot() } : {}),
      // `html` is best-effort text view of the body - only meaningful for text-like
      // content-types. Empty for binary payloads so /scrape consumers see the body
      // is binary via the contentType field. `previewText` is bounded to 64 KiB for
      // challenge detection and must not be used as the response body - decode the
      // full buffer by its declared charset.
      html: isTextContentType(contentType)
        ? isHtmlContentType(contentType)
          ? normalizeHtml(decodeTextBody(decodedBytes, contentType))
          : decodeTextBody(decodedBytes, contentType)
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
      reason:
        headersAbort?.signal.aborted && !signal?.aborted
          ? "tier1-response-timeout"
          : proxy
            ? normalizeProxyError(err)
            : err instanceof Error
              ? err.message
              : String(err),
      certificateError: certificateError ?? (isCertificateError(err) ? describeCertificateError(err) : undefined),
    }
  } finally {
    clearTimeout(headersTimer)
  }
}
