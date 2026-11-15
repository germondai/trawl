// DataDome token solver via direct API call.
//
// Instead of solving the widget through the UI, this generates a valid jspl payload
// and posts it to DataDome's API endpoint to obtain a clearance cookie directly.

import type { Page } from "patchright"
import { encrypt } from "./crypto"
import { buildPayloadWithVariation } from "./builder"

const DD_ENDPOINT = "https://api-js.datadome.co/js/"
const DD_VERSION = "5.11.4"

export interface SolverOptions {
  // The DataDome key for the site (ddk parameter, usually the hash from interstitial)
  ddk: string
  // The client ID (cid parameter)
  cid: string
  // The site's origin
  origin: string
  // The page URL where the wall appeared
  url: string
  // Optional ddjskey for encryption (defaults to ddk)
  ddjskey?: string
  // Timeout in milliseconds
  timeoutMs?: number
}

export interface SolverResult {
  success: boolean
  cookie?: string
  error?: string
}

// Extract DataDome parameters from the interstitial page
export async function extractDdParams(page: Page): Promise<{ ddk: string; cid: string; hash: string } | undefined> {
  try {
    // Try to find the ddm object in the page
    const params = await page.evaluate(() => {
      // Check for ddm global (interstitial page)
      const w = window as unknown as {
        ddm?: { hash?: string; cid?: string }
        dd?: { hsh?: string; cid?: string; cookie?: string }
      }

      if (w.ddm) {
        return {
          ddk: w.ddm.hash ?? "",
          cid: w.ddm.cid ?? "",
          hash: w.ddm.hash ?? "",
        }
      }

      // Check for dd global (block page)
      if (w.dd) {
        return {
          ddk: w.dd.hsh ?? "",
          cid: w.dd.cid ?? "",
          hash: w.dd.hsh ?? "",
        }
      }

      return null
    })

    return params ?? undefined
  } catch {
    return undefined
  }
}

// Extract parameters from a captcha URL
export function extractFromCaptchaUrl(
  captchaUrl: string,
): { cid: string; hash: string; initialCid: string } | undefined {
  try {
    const url = new URL(captchaUrl)
    const cid = url.searchParams.get("cid")
    const hash = url.searchParams.get("hash")
    const initialCid = url.searchParams.get("initialCid")

    if (cid && hash) {
      return { cid, hash, initialCid: initialCid ?? "" }
    }
  } catch {
    // Invalid URL
  }
  return undefined
}

// Solve DataDome by generating and posting a jspl payload
export async function solveDataDomeDirect(
  page: Page,
  options: SolverOptions,
  random: () => number = Math.random,
): Promise<SolverResult> {
  const { ddk, cid, origin, url, ddjskey = ddk, timeoutMs = 10000 } = options

  try {
    // Build the fingerprint payload
    const payload = buildPayloadWithVariation(url, ddk, random)

    // Encrypt the payload
    const jspl = encrypt(payload, ddjskey, cid)

    // Build form data
    const body = new URLSearchParams({
      jspl,
      eventCounters: "[]",
      jsType: random() > 0.5 ? "le" : "ch",
      cid,
      ddk,
      Referer: encodeURIComponent(url),
      request: new URL(url).pathname,
      responsePage: "origin",
      ddv: DD_VERSION,
    })

    // Make the request through the page's context (inherits cookies/session)
    const response = await page.request.post(DD_ENDPOINT, {
      data: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*",
        Origin: origin,
        Referer: url,
        "User-Agent": payload.ua as string,
      },
      timeout: timeoutMs,
    })

    if (!response.ok()) {
      return { success: false, error: `http ${response.status()}` }
    }

    const json = (await response.json().catch(() => null)) as {
      status?: number
      cookie?: string
    } | null

    if (!json || typeof json !== "object") {
      return { success: false, error: "invalid response" }
    }

    if (json.status !== 200) {
      return { success: false, error: `status ${json.status}` }
    }

    const raw = json.cookie
    if (!raw || typeof raw !== "string") {
      return { success: false, error: "no cookie in response" }
    }

    // Extract cookie value (format: "datadome=<value>; ...")
    const match = /^datadome=([^;]+)/.exec(raw)
    if (!match) {
      return { success: false, error: "malformed cookie" }
    }

    console.log("[datadome-direct] obtained clearance cookie")
    return { success: true, cookie: match[1] }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// Apply the obtained cookie to the page context
export async function applyCookie(page: Page, cookie: string, domain: string): Promise<void> {
  await page.context().addCookies([
    {
      name: "datadome",
      value: cookie,
      domain,
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    },
  ])
}

// Full flow: extract params, solve, apply cookie
export async function solveDataDomeDirectFlow(page: Page, targetUrl: string, timeoutMs = 10000): Promise<boolean> {
  // Extract parameters from the page
  const params = await extractDdParams(page)
  if (!params) {
    console.log("[datadome-direct] could not extract DataDome parameters from page")
    return false
  }

  const { ddk, cid, hash } = params
  if (!ddk || !cid) {
    console.log("[datadome-direct] missing ddk or cid")
    return false
  }

  // Determine origin and domain
  let origin: string
  let domain: string
  try {
    const url = new URL(targetUrl)
    origin = url.origin
    domain = "." + url.hostname.split(".").slice(-2).join(".")
  } catch {
    console.log("[datadome-direct] invalid target URL")
    return false
  }

  // Solve
  const result = await solveDataDomeDirect(page, {
    ddk,
    cid,
    ddjskey: hash,
    origin,
    url: targetUrl,
    timeoutMs,
  })

  if (!result.success || !result.cookie) {
    console.log(`[datadome-direct] failed: ${result.error}`)
    return false
  }

  // Apply cookie
  await applyCookie(page, result.cookie, domain)
  console.log("[datadome-direct] cookie applied, reloading...")

  // Reload to verify
  await page.reload({ timeout: timeoutMs })

  return true
}
