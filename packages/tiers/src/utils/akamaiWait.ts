import type { Page } from "patchright"
import { hasAkamaiChallenge } from "./detect"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const hostnameFor = (url?: string) => {
  try {
    return url ? new URL(url).hostname : ""
  } catch {
    return ""
  }
}

export async function waitForAkamaiResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
): Promise<"ok" | "ip-blocked" | "timeout"> {
  const deadline = Date.now() + Math.max(timeoutMs, 0)
  const targetHost = hostnameFor(originalUrl ?? page.url())

  const early = await page.content().catch(() => "")
  if (early && !hasAkamaiChallenge(early)) {
    await page
      .waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(5000, deadline - Date.now())) })
      .catch(() => {})
    return "ok"
  }
  if (Date.now() >= deadline) return "timeout"

  await sleep(Math.min(1500, Math.max(deadline - Date.now(), 0)))

  let heldOnce = false
  let navigatedOnce = false
  let sawCookieAt: number | undefined

  while (Date.now() < deadline) {
    const html = await page.content().catch(() => "")
    if (html && !hasAkamaiChallenge(html)) {
      await page
        .waitForLoadState("load", { timeout: Math.max(1, Math.min(5000, deadline - Date.now())) })
        .catch(() => {})
      return "ok"
    }

    const hasAbck = await pageHasAkamaiCookie(page, targetHost)
    if (hasAbck && sawCookieAt === undefined) {
      sawCookieAt = Date.now()
      console.log("[akamai] _abck cookie present")
    }
    if (hasAbck && !navigatedOnce && originalUrl && sawCookieAt && Date.now() - sawCookieAt > 6000) {
      navigatedOnce = true
      console.log("[akamai] cookie set but still on interstitial — navigating to original URL")
      await page
        .goto(originalUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1, Math.min(15_000, deadline - Date.now())),
        })
        .catch(() => {})
      await page
        .waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(8_000, deadline - Date.now())) })
        .catch(() => {})
      const resolvedHtml = await page.content().catch(() => "")
      return resolvedHtml && !hasAkamaiChallenge(resolvedHtml) ? "ok" : "ip-blocked"
    }

    if (!heldOnce && deadline - Date.now() > 6000) heldOnce = await pressAndHold(page, deadline)

    if (!heldOnce) await wanderMouse(page, 1, deadline)
    await sleep(Math.min(600, Math.max(deadline - Date.now(), 0)))
  }

  return "timeout"
}

async function pageHasAkamaiCookie(page: Page, targetHost: string): Promise<boolean> {
  const cookies: Array<{ name: string; value: string; domain: string }> = await page
    .context()
    .cookies()
    .catch(() => [])
  const abck = cookies.find(
    (cookie) =>
      cookie.name === "_abck" &&
      targetHost &&
      (cookie.domain === targetHost ||
        cookie.domain === `.${targetHost}` ||
        targetHost.endsWith(`.${cookie.domain.replace(/^\./, "")}`)),
  )
  if (!abck) return false
  const seg = abck.value.split("~")[1]
  return seg !== undefined && seg !== "-1"
}

async function wanderMouse(page: Page, points: number, deadline: number): Promise<void> {
  try {
    const vp = page.viewportSize() || { width: 1280, height: 800 }
    let x = Math.random() * vp.width
    let y = Math.random() * vp.height
    for (let i = 0; i < points; i++) {
      if (Date.now() >= deadline) break
      const nx = Math.max(2, Math.min(vp.width - 2, x + (Math.random() - 0.5) * vp.width * 0.5))
      const ny = Math.max(2, Math.min(vp.height - 2, y + (Math.random() - 0.5) * vp.height * 0.5))
      await page.mouse.move(nx, ny, { steps: 1 })
      x = nx
      y = ny
      await sleep(Math.min(60 + Math.random() * 140, Math.max(deadline - Date.now(), 0)))
    }
  } catch {
    // Navigation can temporarily invalidate the input target.
  }
}

async function pressAndHold(page: Page, deadline: number): Promise<boolean> {
  const sel = "#progress-button, .behavioral-button, #sec-if-cpt-container [role='button']"
  let mouseDown = false
  let navigated = false
  const navigation = (frame: unknown) => {
    if (frame === page.mainFrame()) navigated = true
  }
  page.on("framenavigated", navigation)
  try {
    const box = await page
      .evaluate((selector) => {
        for (const el of document.querySelectorAll(selector)) {
          const r = el.getBoundingClientRect()
          if (r.width >= 4 && r.height >= 4 && getComputedStyle(el).visibility !== "hidden")
            return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
      }, sel)
      .catch(() => undefined)
    if (!box || Date.now() >= deadline || navigated) return false
    const cx = box.x + box.width / 2,
      cy = box.y + box.height / 2
    await page.mouse.move(cx, cy, { steps: 1 })
    if (navigated || Date.now() >= deadline) return navigated
    await page.mouse.down()
    mouseDown = true
    const holdUntil = Math.min(deadline, Date.now() + 5500)
    // Holding requires no repeated pointer input. Stop when the document changes
    // so the old challenge's gesture cannot delay reading the destination.
    while (!navigated && Date.now() < holdUntil) await sleep(Math.min(100, Math.max(holdUntil - Date.now(), 0)))
    return true
  } catch {
    return false
  } finally {
    page.off("framenavigated", navigation)
    if (mouseDown) await page.mouse.up().catch(() => {})
  }
}
