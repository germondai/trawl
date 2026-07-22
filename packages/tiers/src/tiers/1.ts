import { FINGERPRINT } from "@trawl/browser"
import type { TierResult } from "@trawl/types"
import {
  hasAkamaiChallenge,
  hasHcaptcha,
  hasRecaptcha,
  hasTurnstile,
  isBlocked,
  isCloudflarePage,
} from "../utils/detect"
import { normalizeHtml } from "../utils/html"

export interface Tier1Result extends TierResult {
  tier: 1
  html?: string
  statusCode?: number
}

export async function runTier1(
  url: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
): Promise<Tier1Result> {
  const start = Date.now()
  try {
    const res = await fetch(url, {
      method: method ?? "GET",
      body: method === "POST" ? body : undefined,
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

    const html = await res.text()
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k] = v
    })

    if (isCloudflarePage(html, headers)) {
      return { tier: 1, status: "needs-js", durationMs: Date.now() - start, reason: "cloudflare-challenge" }
    }

    // JS-only challenges: the page's static HTML is just a shell that loads the
    // captcha widget via <script src="...api.js">. Plain fetch sees the shell and
    // would otherwise report success — but the real content (including the widget)
    // only renders after JS executes. Escalate so Tier 3 runs the page in a browser,
    // executes JS, and the solver can engage the actual widget.
    if (hasHcaptcha(html)) {
      return { tier: 1, status: "needs-js", durationMs: Date.now() - start, reason: "hcaptcha-shell" }
    }
    if (hasRecaptcha(html)) {
      return { tier: 1, status: "needs-js", durationMs: Date.now() - start, reason: "recaptcha-shell" }
    }
    if (hasTurnstile(html)) {
      return { tier: 1, status: "needs-js", durationMs: Date.now() - start, reason: "turnstile-shell" }
    }
    // Akamai's behavioral interstitial is served with HTTP 200; escalate to a browser
    // tier so the sensor JS runs and akamaiWait can drive the challenge.
    if (hasAkamaiChallenge(html, headers)) {
      return { tier: 1, status: "needs-js", durationMs: Date.now() - start, reason: "akamai-interstitial" }
    }

    if (isBlocked(res.status, html)) {
      return { tier: 1, status: "blocked", durationMs: Date.now() - start, reason: `http-${res.status}` }
    }

    return {
      tier: 1,
      status: "success",
      durationMs: Date.now() - start,
      html: normalizeHtml(html),
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
