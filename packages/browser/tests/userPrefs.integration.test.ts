import { describe, expect, test } from "bun:test"
import { BrowserPool } from "../src/pool"

// Local DNS mapping isolates Firefox's .onion block from Tor network availability.
describe.skipIf(process.env.TRAWL_USER_PREFS_TESTS !== "1")("Camoufox user preferences integration", () => {
  test.each([false, true])(
    "applies preferences in virtualDisplay=%s",
    async (virtualDisplay) => {
      const server = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch: () =>
          new Response('<html><body>Fixture<script>document.body.dataset.jsRan="yes"</script></body></html>', {
            headers: { "content-type": "text/html" },
          }),
      })
      try {
        for (const enabled of [true, false]) {
          const pool = new BrowserPool({
            poolSize: 1,
            virtualDisplay,
            hardwareConcurrency: 4,
            contentProcesses: 2,
            userPrefs: {
              "javascript.enabled": enabled,
              "network.dns.blockDotOnion": enabled,
              "network.dns.localDomains": "trawl-fixture.onion",
            },
          })
          try {
            await pool.init()
            const handle = await pool.acquire("fixture.example", 15_000)
            const page = await handle.context.newPage()
            await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded", timeout: 15_000 })
            expect(await page.evaluate(() => document.body.dataset.jsRan === "yes")).toBe(enabled)
            const onion = `http://trawl-fixture.onion:${server.port}/`
            if (enabled) {
              await expect(page.goto(onion, { waitUntil: "domcontentloaded", timeout: 15_000 })).rejects.toThrow(
                "NS_ERROR_UNKNOWN_HOST",
              )
            } else {
              expect((await page.goto(onion, { waitUntil: "domcontentloaded", timeout: 15_000 }))?.status()).toBe(200)
              expect(await page.content()).toContain("Fixture")
            }
            pool.release(handle.id, handle.lease)
          } finally {
            await pool.shutdown()
          }
        }
      } finally {
        server.stop(true)
      }
    },
    240_000,
  )
})
