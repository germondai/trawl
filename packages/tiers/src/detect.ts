export type ChallengeType =
  | "cloudflare-interstitial"
  | "cloudflare-turnstile"
  | "hcaptcha"
  | "recaptcha"
  | "cap"
  | "imperva"
  | "none"

export function isCloudflarePage(html: string, headers: Record<string, string>): boolean {
  if (headers["cf-mitigated"]) return true
  if (/<title>[^<]*(just a moment|ddos-guard|please wait|checking)[^<]*<\/title>/i.test(html)) return true
  if (/checking your browser/i.test(html)) return true
  if (/enable javascript and cookies to continue/i.test(html)) return true
  if (/verify you are human/i.test(html)) return true
  // id-based checks: specific to CF challenge DOM, not present in real pages
  if (/id="challenge-running"/i.test(html)) return true
  if (/id="cf-challenge-running"/i.test(html)) return true
  // CF Turnstile interstitial wrapper
  if (/id="turnstile-wrapper"/i.test(html)) return true
  // DDoS-Guard
  if (/ddos-guard\.net|\.ddos-guard\.net/i.test(html)) return true
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

export function detectChallengeType(html: string, headers: Record<string, string> = {}): ChallengeType {
  if (hasTurnstile(html)) return "cloudflare-turnstile"
  if (isCloudflarePage(html, headers)) return "cloudflare-interstitial"
  if (hasImpervaChallenge(html, headers)) return "imperva"
  if (hasHcaptcha(html)) return "hcaptcha"
  if (hasRecaptcha(html)) return "recaptcha"
  if (hasCapChallenge(html)) return "cap"
  return "none"
}

export function isBlocked(status: number, html: string): boolean {
  // 202 is used by some CDNs (e.g. IMDB) as a bot-gate before the real response
  if (status === 202 || status === 403 || status === 429) return true
  if (isCloudflarePage(html, {})) return true
  if (hasImpervaChallenge(html)) return true
  return false
}

export function needsJs(html: string, headers: Record<string, string>): boolean {
  return isCloudflarePage(html, headers) || hasImpervaChallenge(html, headers)
}
