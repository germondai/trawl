// Mirrors Byparr's CF challenge resolution strategy:
// poll title every 300ms, try Turnstile click every 3s via shadow DOM → frame → coords → keyboard.
// Navigates manually if cf_clearance is set but redirect hasn't fired after 5s.

import type { Frame, Page } from "patchright"
import { hasTurnstile, isCloudflarePage } from "./detect"

export const CF_CHALLENGE_TITLE = /just a moment|verify you are human|please wait|one more step|attention required/i

const CF_CHALLENGE_ORIGINS = ["challenges.cloudflare.com", "cdn-cgi/challenge-platform"]

export async function waitForChallengeResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
): Promise<"ok" | "ip-blocked" | "timeout"> {
  const deadline = Date.now() + Math.max(timeoutMs, 30_000)
  let lastClickAttempt = 0
  let cfClearanceAt: number | null = null

  // Only count cf_clearance for the current domain — warm browser may have cookies from prior domains
  const targetHost = (() => {
    try {
      return new URL(originalUrl ?? page.url()).hostname
    } catch {
      return ""
    }
  })()

  const earlyTitle = await page.title().catch(() => "")
  if (earlyTitle && !CF_CHALLENGE_TITLE.test(earlyTitle)) {
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
    return "ok"
  }

  // Let CF's challenge JS boot up before we start polling
  await new Promise((r) => setTimeout(r, 1000))

  while (Date.now() < deadline) {
    try {
      const title = await page.title().catch(() => "just a moment")
      if (!CF_CHALLENGE_TITLE.test(title)) {
        // 'load' not 'networkidle' — networkidle stalls indefinitely on JS-heavy pages
        await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {})
        return "ok"
      }

      const url = page.url()
      if (/\/cdn-cgi\/error\/|error=1020|error=1015/.test(url)) return "ip-blocked"

      const cookies: Array<{ name: string; domain: string }> = await page
        .context()
        .cookies()
        .catch(() => [])
      const hasDomainClearance = cookies.some(
        (c) =>
          c.name === "cf_clearance" &&
          targetHost &&
          (c.domain === targetHost ||
            c.domain === `.${targetHost}` ||
            targetHost.endsWith(c.domain.replace(/^\./, ""))),
      )
      if (hasDomainClearance) {
        if (cfClearanceAt === null) {
          cfClearanceAt = Date.now()
          console.log("[challenge] cf_clearance obtained")
        }
        // CF auto-redirect normally fires within 2-3s. If it hasn't, navigate ourselves.
        if (originalUrl && Date.now() - cfClearanceAt > 5000) {
          console.log("[challenge] cf_clearance set but still on challenge page — navigating to original URL")
          await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {})
          await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
          return "ok"
        }
      }

      const now = Date.now()
      if (now - lastClickAttempt >= 3000) {
        lastClickAttempt = now
        await attemptTurnstileClick(page).catch(() => {})
      }
    } catch {
      // Page is mid-navigation — keep polling
    }

    await new Promise((r) => setTimeout(r, 300))
  }

  return "timeout"
}

async function attemptTurnstileClick(page: Page): Promise<boolean> {
  const frames = page.frames()
  for (const frame of frames) {
    if (!isChallengeFrame(frame)) continue

    // A: shadow DOM click via shadowRootUnl patch — real DOM event, resolves faster than coords
    const shadowClicked = await clickShadowCheckbox(page, frame)
    if (shadowClicked) return true

    // B: direct frame DOM (may fail under Firefox Fission cross-origin isolation)
    const clicked = await clickInFrame(frame)
    if (clicked) return true

    // C: page-coordinate click — bypasses Fission by clicking on page instead of inside frame
    const frameEl = await frame.frameElement().catch(() => null)
    const box = frameEl ? await frameEl.boundingBox().catch(() => null) : null
    if (box && box.width > 20) {
      const cx = box.x + Math.min(24, box.width * 0.15)
      const cy = box.y + box.height / 2
      await page.mouse.move(cx, cy)
      await new Promise((r) => setTimeout(r, 150))
      await page.mouse.click(cx, cy)
      console.log(
        `[challenge] Turnstile coord-click at (${Math.round(cx)},${Math.round(cy)}) iframe=${Math.round(box.width)}x${Math.round(box.height)}`,
      )
      return true
    }
  }

  // D: keyboard Tab → Space — last resort
  const html = await page.content().catch(() => "")
  if (hasTurnstile(html) || isCloudflarePage(html, {})) {
    try {
      await page.keyboard.press("Tab")
      await new Promise((r) => setTimeout(r, 200))
      await page.keyboard.press("Space")
      console.log("[challenge] Turnstile keyboard Tab+Space attempted")
      return true
    } catch {}
  }

  return false
}

// Requires: (1) pool.ts injects the shadowRootUnl patch, (2) forceScopeAccess: true in Camoufox config
async function clickShadowCheckbox(_page: Page, frame: Frame): Promise<boolean> {
  try {
    const handle = await frame
      .evaluateHandle(() => {
        // biome-ignore lint/suspicious/noExplicitAny: shadow DOM traversal
        const roots: any[] = []
        // biome-ignore lint/suspicious/noExplicitAny: shadow DOM traversal
        function collect(node: any) {
          if (!node) return
          if (node.shadowRootUnl) {
            roots.push(node.shadowRootUnl)
            collect(node.shadowRootUnl)
          }
          try {
            const children = node.querySelectorAll("*")
            for (const el of children) collect(el)
          } catch {
            /* shadow boundary */
          }
        }
        collect(document)
        return roots
      })
      .catch(() => null)

    if (!handle) return false

    const props = await handle.getProperties().catch(() => null)
    if (!props) return false

    for (const [, shadowHandle] of props) {
      const el = shadowHandle.asElement()
      if (!el) continue
      const checkboxHandle = await el
        // biome-ignore lint/suspicious/noExplicitAny: shadow root handle
        .evaluateHandle((root: any) => root.querySelector('input[type="checkbox"]'))
        .catch(() => null)
      if (!checkboxHandle) continue
      const checkbox = checkboxHandle.asElement()
      if (!checkbox) continue
      const visible = await checkbox.isVisible().catch(() => false)
      if (!visible) continue
      await checkbox.click({ timeout: 2000 }).catch(() => {})
      console.log("[challenge] Turnstile shadow-DOM checkbox clicked")
      return true
    }
  } catch {
    // Shadow DOM not accessible (init script not injected or forceScopeAccess not set)
  }
  return false
}

function isChallengeFrame(frame: Frame): boolean {
  const url = frame.url()
  return CF_CHALLENGE_ORIGINS.some((o) => url.includes(o))
}

async function clickInFrame(frame: Frame): Promise<boolean> {
  const selectors = [
    '[role="checkbox"]',
    "role=checkbox",
    ".ctp-checkbox-label",
    "label",
    'input[type="checkbox"]',
    "#challenge-stage div",
    ".cb-i",
  ]
  for (const sel of selectors) {
    try {
      const el = frame.locator(sel).first()
      if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
        await el.click({ timeout: 1500, force: true })
        console.log(`[challenge] Turnstile frame-click: "${sel}"`)
        return true
      }
    } catch {}
  }
  return false
}
