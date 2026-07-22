// Akamai Bot Manager "Behavioral Detection" (sec-cpt / SBSD) resolver — the Akamai
// analogue of challengeWait.ts (Cloudflare) and impervaWait.ts (Imperva).
//
// Akamai's interstitial is a hidden #sec-if-cpt-container ("behavioral-content")
// driven by an obfuscated sensor script. The sensor collects pointer/timing telemetry
// and POSTs it; an inline hook then location.reload()s into the real page. Some
// variants also surface a press-and-hold "progress button" that must be actuated.
//
// Unlike CF/Imperva (which resolve from JS execution + a cookie alone), Akamai's
// behavioral challenge scores *interaction*, so we drive human-like mouse motion and,
// if the hold button becomes visible, press-and-hold it — then wait for the reload.
//
// Known risk: Akamai's behavioral scoring is adversarial to synthetic input; success
// is not guaranteed even from a real browser. Camoufox emits genuine Firefox-level
// pointer events (not CDP synthetic ones), which is the best available shot.

import type { Page } from "patchright"
import { hasAkamaiChallenge } from "./detect"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitForAkamaiResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
): Promise<"ok" | "ip-blocked" | "timeout"> {
  const deadline = Date.now() + Math.max(timeoutMs, 35_000)

  const early = await page.content().catch(() => "")
  if (early && !hasAkamaiChallenge(early)) {
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
    return "ok"
  }

  // Let the sensor script boot and start listening for behavioral telemetry.
  await sleep(1500)
  await wanderMouse(page, 8)

  let heldOnce = false
  let navigatedOnce = false
  const sawCookieAt: { t: number | null } = { t: null }

  while (Date.now() < deadline) {
    const html = await page.content().catch(() => "")
    if (html && !hasAkamaiChallenge(html) && html.length > 3500) {
      await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {})
      return "ok"
    }

    // Once Akamai has set its clearance cookie but the reload hasn't fired, give it a
    // grace period then navigate to the original URL ourselves (mirrors CF/Imperva).
    const hasAbck = await pageHasAkamaiCookie(page)
    if (hasAbck && sawCookieAt.t === null) {
      sawCookieAt.t = Date.now()
      console.log("[akamai] _abck cookie present")
    }
    if (hasAbck && !navigatedOnce && originalUrl && sawCookieAt.t && Date.now() - sawCookieAt.t > 6000) {
      navigatedOnce = true
      console.log("[akamai] cookie set but still on interstitial — navigating to original URL")
      await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {})
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
      continue
    }

    // If the behavioral widget surfaced a press-and-hold button, actuate it once.
    if (!heldOnce) {
      heldOnce = await pressAndHold(page).catch(() => false)
    }

    await wanderMouse(page, 3)
    await sleep(600)
  }

  return "timeout"
}

async function pageHasAkamaiCookie(page: Page): Promise<boolean> {
  const cookies: Array<{ name: string; value: string }> = await page
    .context()
    .cookies()
    .catch(() => [])
  // A validated _abck has its 2nd '~'-segment != "-1"; presence + validation both help.
  const abck = cookies.find((c) => c.name === "_abck")
  if (!abck) return false
  const seg = abck.value.split("~")[1]
  return seg !== undefined && seg !== "-1"
}

// Move the pointer along a wandering path to produce plausible behavioral telemetry.
async function wanderMouse(page: Page, points: number): Promise<void> {
  try {
    const vp = page.viewportSize() || { width: 1280, height: 800 }
    let x = Math.random() * vp.width
    let y = Math.random() * vp.height
    for (let i = 0; i < points; i++) {
      const nx = Math.max(2, Math.min(vp.width - 2, x + (Math.random() - 0.5) * vp.width * 0.5))
      const ny = Math.max(2, Math.min(vp.height - 2, y + (Math.random() - 0.5) * vp.height * 0.5))
      await page.mouse.move(nx, ny, { steps: 4 + Math.floor(Math.random() * 8) })
      x = nx
      y = ny
      await sleep(60 + Math.random() * 140)
    }
  } catch {
    // page navigating / closed — ignore
  }
}

// Press-and-hold the behavioral "progress button" if the sensor has made it visible.
async function pressAndHold(page: Page): Promise<boolean> {
  const sel = "#progress-button, .behavioral-button, #sec-if-cpt-container [role='button']"
  try {
    const el = page.locator(sel).first()
    if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) return false
    const box = await el.boundingBox().catch(() => null)
    if (!box || box.width < 4 || box.height < 4) return false
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx - 18, cy - 10, { steps: 6 })
    await page.mouse.move(cx, cy, { steps: 8 })
    await page.mouse.down()
    // Hold ~5.5s with micro-jitter so the "progress" bar fills.
    const holdUntil = Date.now() + 5500
    while (Date.now() < holdUntil) {
      await page.mouse.move(cx + (Math.random() - 0.5) * 3, cy + (Math.random() - 0.5) * 3, { steps: 2 })
      await sleep(220)
    }
    await page.mouse.up()
    console.log("[akamai] press-and-hold performed")
    return true
  } catch {
    return false
  }
}
