import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { Trawl, TrawlError } from "@trawl/client"

const commands = ["scrape", "read", "extract", "screenshot", "inspect", "capture", "session"]
const [command, url] = process.argv.slice(2)
if (!commands.includes(command) || !url) {
  console.error(`Usage: bun packages/client/examples/demo.ts <${commands.join("|")}> <url>`)
  process.exit(1)
}

const client = new Trawl({
  baseURL: process.env.TRAWL_BASE_URL || "http://localhost:8191",
  apiKey: process.env.TRAWL_API_KEY || undefined,
  timeoutMs: 70_000,
})
const directory = process.env.TRAWL_DEMO_OUTPUT_DIR || (await mkdtemp(join(tmpdir(), "trawl-client-demo-")))
await mkdir(directory, { recursive: true })
const request = { url, maxTimeout: 60_000, proxy: process.env.TRAWL_PROXY_URL || undefined }
const json = (name: string, value: unknown) => writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)

try {
  switch (command) {
    case "scrape": {
      const page = await client.scrape({ ...request, blockedEvidence: true })
      await writeFile(join(directory, "page.html"), page.html)
      await json("scrape.json", {
        url: page.url,
        statusCode: page.statusCode,
        tier: page.tier,
        totalMs: page.totalMs,
        timings: page.timings,
      })
      console.log(`Target returned HTTP ${page.statusCode}; tier ${page.tier}; ${page.totalMs} ms`)
      break
    }
    case "read": {
      const article = await client.read({ ...request, format: "markdown", maxCharacters: 30_000 })
      await writeFile(join(directory, "article.md"), article.text)
      await json("article.json", article)
      break
    }
    case "extract": {
      const records = await client.extract({
        ...request,
        itemSelector: process.env.TRAWL_ITEM_SELECTOR || undefined,
        fields: { title: { selector: "h1, h2" }, link: { selector: "a", attribute: "href" } },
        maxItems: 25,
      })
      await json("records.json", records)
      break
    }
    case "screenshot": {
      const page = await client.screenshot({ ...request, screenshotFullPage: true })
      await writeFile(join(directory, "page.jpg"), Buffer.from(page.screenshot, "base64"))
      break
    }
    case "inspect": {
      const page = await client.inspect(request)
      await json("diagnostics.json", {
        consoleLogs: page.consoleLogs,
        networkLogs: page.networkLogs,
        redirectChain: page.redirectChain,
      })
      break
    }
    case "capture": {
      const page = await client.scrape({
        ...request,
        skipHttp: true,
        captureResponses: [process.env.TRAWL_CAPTURE_PATTERN || "/api/"],
        settleTimeout: 5_000,
      })
      await json("captured.json", page.capturedResponses ?? [])
      break
    }
    case "session": {
      const session = await client.sessions.create({ keepPage: true, proxy: request.proxy })
      try {
        await session.scrape({ url, maxTimeout: request.maxTimeout })
        const state = await session.eval(
          '({ title: document.title, linkCount: document.querySelectorAll("a").length })',
        )
        const cookieNames = (await session.cookies()).map((cookie) => cookie.name)
        await json("session.json", { state, cookieNames })
      } finally {
        await session.close()
      }
      break
    }
  }
  console.log(`Saved output to ${directory}`)
} catch (error) {
  if (!(error instanceof TrawlError)) throw error
  console.error("TRAWL request failed", { kind: error.kind, status: error.status, retryAfter: error.retryAfter })
  if (error.blockedEvidence) {
    await json("blocked.json", error.blockedEvidence)
    console.error(`Saved blocked evidence to ${directory}`)
  }
  process.exitCode = 1
}
