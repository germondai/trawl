import { Camoufox } from "camoufox-js"

async function main() {
  console.log("[test] launching Camoufox...")
  const browser: any = await Camoufox({
    headless: true,
    geoip: true,
    humanize: true,
    disable_coop: true,
    block_webrtc: true,
    iKnowWhatImDoing: true,
  })

  console.log("[test] creating context...")
  const ctx = await browser.newContext({ viewport: null })
  const page = await ctx.newPage()

  console.log("[test] navigating to example.com...")
  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15000 })

  const ua = await page.evaluate(() => navigator.userAgent)
  const title = await page.title()
  console.log("[test] UA:", ua)
  console.log("[test] Title:", title)
  console.log("[test] navigator.webdriver:", await page.evaluate(() => (navigator as any).webdriver))
  console.log("[test] window.chrome exists:", await page.evaluate(() => !!(window as any).chrome))

  await browser.close()
  console.log("[test] PASS")
}

main().catch((e) => {
  console.error("[test] FAIL:", e.message)
  process.exit(1)
})
