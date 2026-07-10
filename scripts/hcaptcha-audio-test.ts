// Direct end-to-end test of the new hCaptcha audio STT fallback.
// Uses the production BrowserPool from @trawl/browser (same code path the API uses)
// so bun's module resolution can't trip over camoufox-js's internal playwright-core dep.
//
// Run inside the running container:
//   docker exec -w /app trawl-hcaptcha-test bun run /tmp/hcaptcha-audio-test.ts

import { BrowserPool } from "@trawl/browser"
import { solveHcaptcha } from "../packages/tiers/src/solvers/hcaptcha.ts"

process.on("uncaughtException", (err) => {
  console.error("[uncaught]", err.message)
  process.exit(1)
})

async function main() {
  const pool = new BrowserPool({
    size: 1,
    headless: true,
    geoip: true,
    humanize: true,
    block_webrtc: true,
    disable_coop: true,
  })

  console.log("[test] initializing BrowserPool (size=1)...")
  await pool.init()
  console.log("[test] pool ready")

  const handle = await pool.acquire("nopecha.com")
  console.log(`[test] acquired browser handle id=${handle.id}`)

  // BrowserHandle exposes context + browser, not page — create one from the context
  // (same pattern apps/api/src/index.ts uses).
  const page = await handle.context.newPage()

  try {
    const target = "https://nopecha.com/demo/hcaptcha"
    console.log(`[test] visiting ${target}...`)
    await page
      .goto(target, { waitUntil: "domcontentloaded", timeout: 30000 })
      .catch((e: Error) => console.log("[test] goto error:", e.message.slice(0, 120)))

    // Give hCaptcha's api.js time to bootstrap the widget iframe.
    console.log("[test] waiting 8s for hCaptcha widget to render...")
    await new Promise((r) => setTimeout(r, 8000))
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {})

    const html = await page.content().catch(() => "")
    console.log("[test] page.content() length:", html.length)
    console.log("[test] URL:", page.url())
    console.log("[test] Title:", await page.title().catch(() => "?"))

    const frames = page
      .frames()
      .map((f: { url: () => string }) => f.url())
      .filter((u: string) => u && u !== "about:blank")
    console.log("[test] frames:", frames.slice(0, 10))

    // ─── Run the new solver ────────────────────────────────────────────────
    console.log("[test] calling solveHcaptcha(page, 45000)...")
    const t0 = Date.now()
    const solved = await solveHcaptcha(page, 45_000)
    const elapsed = Date.now() - t0
    console.log(`[test] solveHcaptcha returned: ${solved} (took ${elapsed}ms)`)

    await pool.release(handle.id)
    await pool.shutdown()
    console.log("[test] DONE")
    process.exit(solved ? 0 : 2)
  } catch (e) {
    console.error("[test] FAIL:", (e as Error).message)
    await pool.release(handle.id).catch(() => {})
    await pool.shutdown().catch(() => {})
    process.exit(1)
  }
}

main().catch((e: Error) => {
  console.error("[test] FATAL:", e.message)
  process.exit(1)
})
