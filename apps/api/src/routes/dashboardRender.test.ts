import { expect, test } from "bun:test"
import { parseHTML } from "linkedom"
import { MetricsStore } from "../metrics"
import { dashboardPage } from "./dashboardPage"

const GLOBALS = ["document", "window", "matchMedia", "fetch", "setInterval"] as const

// Runs the page's own script against a DOM so a rendering mistake fails here, not in a browser.
async function renderDashboard(store: MetricsStore) {
  const data = store.snapshot(60)
  const { window, document } = parseHTML(dashboardPage(false))
  const script = [...document.querySelectorAll("script")].map((node) => node.textContent).join("\n")
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = Object.fromEntries(GLOBALS.map((name) => [name, globals[name]]))
  const matchMedia = () => ({ matches: false })
  Object.assign(globals, {
    document,
    window: Object.assign(window, { matchMedia }),
    matchMedia,
    // The live feed stays open like the real one; a closed or failed feed would make the page
    // reconnect on a timer and touch `document` after this test has restored the globals.
    fetch: async (url: string) =>
      url.startsWith("/dashboard/events")
        ? new Response(new ReadableStream({ start() {} }), { status: 200 })
        : new Response(JSON.stringify(data), { status: 200 }),
    setInterval: () => 0,
  })
  try {
    new Function(script)()
    await Bun.sleep(50)
    const table = (id: string) =>
      [...document.querySelectorAll(`#${id} tr`)].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""),
      )
    return {
      captchas: table("captchas"),
      events: table("events"),
      failures: table("recent"),
      summary: document.getElementById("captcha-summary")?.textContent ?? "",
    }
  } finally {
    for (const name of GLOBALS) {
      if (saved[name] === undefined) delete globals[name]
      else globals[name] = saved[name]
    }
  }
}

test("renders the CAPTCHA panel and per-request CAPTCHA columns from real metrics", async () => {
  const store = new MetricsStore()
  try {
    store.record({
      source: "native",
      url: "https://ok.example/",
      statusCode: 200,
      durationMs: 10,
      attempts: [
        {
          tier: 3,
          status: "success",
          durationMs: 5,
          captchas: [
            { kind: "altcha", outcome: "solved" },
            { kind: "turnstile:2captcha", outcome: "failed" },
          ],
        },
      ],
    })
    store.record({
      source: "native",
      url: "https://wall.example/",
      statusCode: 403,
      durationMs: 10,
      attempts: [{ tier: 3, status: "blocked", durationMs: 5, captchas: [{ kind: "aws-waf", outcome: "failed" }] }],
    })
    const page = await renderDashboard(store)
    expect(page.captchas).toEqual([
      ["altcha", "1", "1", "0", "100%"],
      ["aws-waf", "1", "0", "1", "0%"],
      ["turnstile (2captcha)", "1", "0", "1", "0%"],
    ])
    expect(page.summary).toContain("3 attempts · 1 solved · 2 failed · 33% success")
    expect(page.events.map((row) => row[6])).toEqual(["aws-waf failed", "altcha solved, turnstile (2captcha) failed"])
    expect(page.failures[0]?.[7]).toBe("aws-waf failed")
  } finally {
    store.close()
  }
})

test("shows an empty state when no CAPTCHA was tried", async () => {
  const store = new MetricsStore()
  try {
    store.record({ source: "native", url: "https://plain.example/", statusCode: 200, durationMs: 3 })
    const page = await renderDashboard(store)
    expect(page.captchas).toEqual([["No CAPTCHAs attempted in this period"]])
    expect(page.events[0]?.[6]).toBe("-")
  } finally {
    store.close()
  }
})
