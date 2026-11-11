// Mirrors Byparr's CF challenge resolution strategy:
// poll title every 300ms, try Turnstile click every 3s via shadow DOM → frame → coords → keyboard.
// Navigates manually if cf_clearance is set but redirect hasn't fired after 5s.

import type { Frame, Page } from "patchright"
import { isCloudflareChallengeTitle, isCloudflareErrorUrl, isCloudflarePage } from "./detect"

export const CF_CHALLENGE_TITLE = /just a moment|verify you are human|please wait|one more step|attention required/i

const CF_CHALLENGE_ORIGINS = ["challenges.cloudflare.com", "cdn-cgi/challenge-platform"]

export async function waitForChallengeResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
  responseHeaders: () => Record<string, string> = () => ({}),
): Promise<"ok" | "ip-blocked" | "timeout"> {
  const deadline = Date.now() + Math.max(timeoutMs, 0)
  let lastClickAttempt = 0
  let hadChallengeFrame = false
  let cfClearanceAt: number | undefined
  let clearanceValue: string | undefined
  let recoveryAttempted = false
  let challengeSeen = false
  let inactiveSamples = 0

  // Only count cf_clearance for the current domain - warm browser may have cookies from prior domains
  const targetHost = (() => {
    try {
      return new URL(originalUrl ?? page.url()).hostname
    } catch {
      return ""
    }
  })()

  while (Date.now() < deadline) {
    try {
      const title = await page.title().catch(() => "")
      const url = page.url()
      const hasChallengeFrame = page.frames().some(isChallengeFrame)
      if (hasChallengeFrame && !hadChallengeFrame) lastClickAttempt = 0
      hadChallengeFrame = hasChallengeFrame
      const headers = responseHeaders()
      const activeSignal =
        isCloudflareChallengeTitle(title) ||
        /\/cdn-cgi\/challenge-platform|\/cdn-cgi\/challenge\//i.test(url) ||
        isCloudflarePage("", headers)
      const html = activeSignal ? "" : await page.content().catch(() => "")
      const active = activeSignal || isCloudflarePage(html, headers)

      if (!active && html.trim()) {
        inactiveSamples++
      } else {
        if (active) challengeSeen = true
        inactiveSamples = 0
      }

      if (isCloudflareErrorUrl(url)) return "ip-blocked"

      // Two observations prevent a transient normal title/DOM during navigation from
      // declaring a challenge solved. This also applies before the first active sample.
      if (inactiveSamples >= 2) {
        // 'load' not 'networkidle' - networkidle stalls indefinitely on JS-heavy pages
        await page
          .waitForLoadState("load", { timeout: Math.max(1, Math.min(5000, deadline - Date.now())) })
          .catch(() => {})
        return "ok"
      }

      if (!active) {
        await new Promise((r) => setTimeout(r, 300))
        continue
      }

      const cookies: Array<{ name: string; domain: string; value?: string }> = await page
        .context()
        .cookies()
        .catch(() => [])
      const domainClearance = cookies.find(
        (c) =>
          c.name === "cf_clearance" &&
          targetHost &&
          (c.domain === targetHost ||
            c.domain === `.${targetHost}` ||
            targetHost.endsWith(`.${c.domain.replace(/^\./, "")}`)),
      )
      if (domainClearance && challengeSeen) {
        if (cfClearanceAt === undefined || clearanceValue !== domainClearance.value) {
          clearanceValue = domainClearance.value
          cfClearanceAt = Date.now()
          console.log("[challenge] cf_clearance obtained")
        }
        // CF auto-redirect normally fires within 2-3s. If it hasn't, navigate ourselves.
        if (originalUrl && Date.now() - cfClearanceAt > 5000) {
          if (recoveryAttempted) return "ip-blocked"
          recoveryAttempted = true
          console.log("[challenge] cf_clearance set but still on challenge page - navigating to original URL")
          await page
            .goto(originalUrl, {
              waitUntil: "domcontentloaded",
              timeout: Math.max(1, Math.min(15_000, deadline - Date.now())),
            })
            .catch(() => {})
          // Navigation can serve another wall even with clearance. Inspect the new
          // document in the next poll instead of passing it to embedded CAPTCHA solvers.
          cfClearanceAt = Date.now()
          continue
        }
      }

      const now = Date.now()
      if (now - lastClickAttempt >= 3000) {
        if (await attemptTurnstileClick(page).catch(() => false)) lastClickAttempt = now
      }
    } catch {
      // Page is mid-navigation - keep polling
    }

    await new Promise((r) => setTimeout(r, 300))
  }

  return "timeout"
}

export async function attemptTurnstileClick(page: Page, allowKeyboard = true): Promise<boolean> {
  const canClick = async () =>
    !allowKeyboard ||
    CF_CHALLENGE_TITLE.test(await page.title().catch(() => "")) ||
    isCloudflarePage(await page.content().catch(() => ""), {})
  const frames = page.frames()
  for (const frame of frames) {
    if (!isChallengeFrame(frame)) continue

    // A: shadow DOM click via shadowRootUnl patch - real DOM event, resolves faster than coords
    const shadowClicked = await clickShadowCheckbox(frame, canClick)
    if (shadowClicked) return true

    // B: direct frame DOM (may fail under Firefox Fission cross-origin isolation)
    const clicked = await clickInFrame(frame, canClick)
    if (clicked) return true

    // C: page-coordinate click - bypasses Fission by clicking on page instead of inside frame
    if (!(await canClick())) return false
    const frameEl = await frame.frameElement().catch(() => undefined)
    if (!frameEl) continue
    try {
      const box = await frameEl.boundingBox().catch(() => undefined)
      if (box && box.width > 20 && (await canClick())) {
        const position = { x: Math.min(24, box.width * 0.15), y: box.height / 2 }
        // Humanized movement can outlive an automatically clearing interstitial.
        await frameEl.hover({ position, timeout: 1500 })
        if (!(await canClick())) return false
        await frameEl.click({ position, timeout: 1500 })
        console.log(`[challenge] Turnstile iframe clicked (${Math.round(box.width)}x${Math.round(box.height)})`)
        return true
      }
    } catch {
      // The challenge can disappear while the target document is loading.
    } finally {
      await frameEl.dispose().catch(() => {})
    }
  }

  // D: keyboard Tab → Space - last resort
  if (!allowKeyboard) return false
  const html = await page.content().catch(() => "")
  const title = await page.title().catch(() => "")
  if (CF_CHALLENGE_TITLE.test(title) || /_cf_chl_opt|id=["'](?:challenge-form|turnstile-wrapper)["']/i.test(html)) {
    try {
      await page.keyboard.press("Tab")
      await new Promise((r) => setTimeout(r, 200))
      if (!(await canClick())) return false
      await page.keyboard.press("Space")
      console.log("[challenge] Cloudflare keyboard verification attempted")
      return true
    } catch {}
  }

  return false
}

// Requires: (1) pool.ts injects the shadowRootUnl patch, (2) forceScopeAccess: true in Camoufox config
async function clickShadowCheckbox(frame: Frame, canClick: () => Promise<boolean>): Promise<boolean> {
  const handles: Array<{ dispose(): Promise<void> }> = []
  try {
    const handle = await frame
      .evaluateHandle(() => {
        type ShadowHost = ParentNode & { shadowRootUnl?: ShadowRoot }
        const roots: ShadowRoot[] = []
        function collect(node: ShadowHost) {
          if (node.shadowRootUnl) {
            roots.push(node.shadowRootUnl)
            collect(node.shadowRootUnl)
          }
          try {
            const children = node.children
            for (const el of children) collect(el)
          } catch {
            /* shadow boundary */
          }
        }
        collect(document)
        return roots
      })
      .catch(() => undefined)

    if (!handle) return false
    handles.push(handle)

    const props = await handle.getProperties().catch(() => undefined)
    if (!props) return false
    handles.push(...props.values())

    for (const [, shadowHandle] of props) {
      const el = shadowHandle.asElement()
      if (!el) continue
      const checkboxHandle = await el
        .evaluateHandle((root: ParentNode) => root.querySelector('input[type="checkbox"]'))
        .catch(() => undefined)
      if (!checkboxHandle) continue
      handles.push(checkboxHandle)
      const checkbox = checkboxHandle.asElement()
      if (!checkbox) continue
      const visible = await checkbox.isVisible().catch(() => false)
      if (!visible) continue
      if (!(await canClick())) return false
      const clicked = await checkbox
        .click({ timeout: 2000 })
        .then(() => true)
        .catch(() => false)
      if (!clicked) continue
      console.log("[challenge] Turnstile shadow-DOM checkbox clicked")
      return true
    }
  } catch {
    // Shadow DOM not accessible (init script not injected or forceScopeAccess not set)
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})))
  }
  return false
}

function isChallengeFrame(frame: Frame): boolean {
  const url = frame.url()
  return CF_CHALLENGE_ORIGINS.some((o) => url.includes(o))
}

async function clickInFrame(frame: Frame, canClick: () => Promise<boolean>): Promise<boolean> {
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
        if (!(await canClick())) return false
        await el.click({ timeout: 1500, force: true })
        console.log(`[challenge] Turnstile frame-click: "${sel}"`)
        return true
      }
    } catch {}
  }
  return false
}
