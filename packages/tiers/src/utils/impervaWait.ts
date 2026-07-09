// Imperva/Incapsula sensor-cookie wait — mirrors challengeWait.ts's CF polling loop.
// Imperva's reese84 (current) / ___utmvc (legacy) cookies are produced by an obfuscated
// in-page JS challenge that a real browser executing real JS satisfies without any
// challenge-specific logic — we just wait for the cookie and let the page proceed.
//
// Known risk: unlike CF Turnstile, Imperva's script sometimes layers in TLS/JA3 and
// behavioral checks beyond plain cookie generation — success isn't guaranteed just
// because we're a real browser. Validate against a real Imperva-protected site.

import type { Page } from "patchright"
import { hasImpervaChallenge } from "./detect"

export async function waitForImpervaResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
): Promise<"ok" | "ip-blocked" | "timeout"> {
  const deadline = Date.now() + Math.max(timeoutMs, 30_000)
  let sensorCookieAt: number | null = null

  const targetHost = (() => {
    try {
      return new URL(originalUrl ?? page.url()).hostname
    } catch {
      return ""
    }
  })()

  const earlyHtml = await page.content().catch(() => "")
  if (earlyHtml && !hasImpervaChallenge(earlyHtml)) {
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
    return "ok"
  }

  // Let Imperva's sensor JS boot up before polling
  await new Promise((r) => setTimeout(r, 1000))

  while (Date.now() < deadline) {
    try {
      const cookies: Array<{ name: string; domain: string }> = await page
        .context()
        .cookies()
        .catch(() => [])
      const hasSensorCookie = cookies.some(
        (c) =>
          (c.name === "reese84" || c.name === "___utmvc") &&
          targetHost &&
          (c.domain === targetHost ||
            c.domain === `.${targetHost}` ||
            targetHost.endsWith(c.domain.replace(/^\./, ""))),
      )

      if (hasSensorCookie) {
        if (sensorCookieAt === null) {
          sensorCookieAt = Date.now()
          console.log("[imperva] sensor cookie obtained")
        }

        const html = await page.content().catch(() => "")
        if (!hasImpervaChallenge(html)) {
          await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {})
          return "ok"
        }

        // Sensor cookie set but still on the challenge page — Imperva's redirect
        // sometimes doesn't auto-fire (unlike CF). Navigate ourselves after a grace period.
        if (originalUrl && Date.now() - sensorCookieAt > 5000) {
          console.log("[imperva] sensor cookie set but still on challenge page — navigating to original URL")
          await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {})
          await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
          const html2 = await page.content().catch(() => "")
          if (hasImpervaChallenge(html2)) return "ip-blocked"
          return "ok"
        }
      }
    } catch {
      // Page is mid-navigation — keep polling
    }

    await new Promise((r) => setTimeout(r, 300))
  }

  return "timeout"
}
