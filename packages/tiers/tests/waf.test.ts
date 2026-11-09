import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { gzipSync } from "node:zlib"
import type { WafDetection } from "@trawl/types"
import { type OrchestratorDeps, ScrapeError, scrape } from "../src/orchestrator"
import { snapshotWafEvidence, WafDetector } from "../src/utils/waf"
import { ANUBIS_CHALLENGE } from "./fixtures/anubis"
import { withFetch } from "./helpers/fetch"

const detection: WafDetection = { engine: "wafmeow", version: "3.1.0", state: "complete", products: ["Cloudflare"] }
const workers: WafDetector[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
})

function worker(script: string): WafDetector {
  const detector = new WafDetector([process.execPath, "-e", script])
  workers.push(detector)
  return detector
}

const fakeWorker = (result: unknown) => `
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let end;
  while ((end = buffer.indexOf("\\n")) !== -1) {
    JSON.parse(buffer.slice(0, end));
    console.log(${JSON.stringify(JSON.stringify(result))});
    buffer = buffer.slice(end + 1);
  }
}`
const evidence = snapshotWafEvidence({
  statusCode: 200,
  html: "ordinary page",
  responseHeaders: { server: "cloudflare" },
})

test.skipIf(!existsSync(process.env.WAFMEOW_PATH?.trim() || "/opt/trawl-waf/trawl-waf"))(
  "bundled helper classifies header, body and separate cookie evidence",
  async () => {
    const detector = new WafDetector()
    workers.push(detector)
    for (const [input, product] of [
      [{ responseHeaders: { server: "cloudflare" }, html: "ordinary content" }, "Cloudflare (Cloudflare Inc.)"],
      [
        {
          responseHeaders: { "set-cookie": "session=plain; Path=/\nvisid_incap_123=owned; Path=/" },
          html: "ordinary content",
        },
        "Incapsula (Imperva Inc.)",
      ],
      [{ html: '<script id="anubis_version" type="application/json">"1.0"</script>' }, "Anubis (Techaro)"],
    ] as const) {
      const result = await detector.detect(
        snapshotWafEvidence({ statusCode: 200, reasonPhrase: "OK", ...input }),
        1_000,
      )
      expect(result.state).not.toBe("unavailable")
      expect(result.products).toContain(product)
      expect(result.matches).toContainEqual({
        product,
        schema: expect.any(Number),
        fingerprints: expect.arrayContaining([{ fingerprint: expect.any(Number), evidence: 0 }]),
      })
    }
    const partial = await detector.detect(
      snapshotWafEvidence({
        statusCode: 200,
        reasonPhrase: "OK",
        responseHeaders: { server: "cloudflare" },
        html: "x".repeat(80_000),
      }),
      1_000,
    )
    expect(partial.state).toBe("incomplete")
    expect(partial.products).toContain("Cloudflare (Cloudflare Inc.)")
    expect(partial.incompleteProducts?.length).toBeGreaterThan(0)
    expect(partial.diagnostics).toContainEqual({ code: "body_truncated", evidence: 0 })
  },
)

test("bounds evidence and distinguishes missing and truncated bodies", () => {
  const bounded = JSON.parse(
    snapshotWafEvidence({ html: "é".repeat(100_000), responseHeaders: { huge: "x".repeat(20_000) } }),
  )
  expect(Buffer.from(bounded.body, "base64").length).toBe(65_536)
  expect(bounded.availability).toMatchObject({ body: "incomplete", headers: "incomplete", status: "unavailable" })
  expect(JSON.parse(snapshotWafEvidence({ statusCode: 403 })).availability.body).toBe("unavailable")
  const withReason = JSON.parse(snapshotWafEvidence({ statusCode: 403, reasonPhrase: "Forbidden" }))
  expect(withReason.reason).toBe("Forbidden")
  expect(withReason.availability.reason).toBe("complete")
})

test("preserves individual Set-Cookie fields including commas in expiry dates", () => {
  const captured = JSON.parse(
    snapshotWafEvidence({
      responseHeaders: {
        "set-cookie": "session=plain; Expires=Wed, 01 Jan 2031 00:00:00 GMT\nvisid_incap_123=provider; Path=/",
      },
    }),
  )
  expect(captured.headers).toEqual([
    { name: "set-cookie", value: "session=plain; Expires=Wed, 01 Jan 2031 00:00:00 GMT" },
    { name: "set-cookie", value: "visid_incap_123=provider; Path=/" },
  ])
})

test("streams repeated detections and returns only provider metadata", async () => {
  const detector = worker(fakeWorker({ ...detection, private: "must not escape" }))
  expect(await detector.detect(evidence, 1_000)).toMatchObject({ ...detection, durationMs: expect.any(Number) })
  expect(await detector.detect(evidence, 1_000)).toMatchObject(detection)
})

test("preserves bounded WAF details while stripping nested raw evidence", async () => {
  const details = {
    matches: [{ product: "Cloudflare", schema: 1, fingerprints: [{ fingerprint: 1, evidence: 0 }] }],
    incompleteProducts: ["Body provider"],
    diagnostics: [{ code: "body_truncated", evidence: 0 }],
    detailsTruncated: true,
  }
  const detector = worker(
    fakeWorker({
      ...detection,
      ...details,
      matches: [
        {
          ...details.matches[0],
          html: "private-html",
          fingerprints: [{ ...details.matches[0]?.fingerprints[0], value: "private-cookie" }],
        },
      ],
      diagnostics: [{ ...details.diagnostics[0], message: "private-url" }],
    }),
  )
  const result = await detector.detect(evidence, 1_000)
  expect(result).toMatchObject({ ...detection, ...details })
  expect(JSON.stringify(result)).not.toContain("private")
})

test("rejects invalid rule references and malformed optional metadata", async () => {
  const match = { product: "Cloudflare", schema: 1, fingerprints: [{ fingerprint: 1, evidence: 0 }] }
  for (const details of [
    { matches: [{ ...match, schema: 0 }] },
    { matches: [{ ...match, fingerprints: [{ fingerprint: 1, evidence: 1 }] }] },
    { matches: Array(33).fill(match) },
    { incompleteProducts: "Cloudflare" },
    { diagnostics: [{ code: "private-code", evidence: 0 }] },
    { detailsTruncated: 1 },
  ]) {
    const detector = worker(fakeWorker({ ...detection, ...details }))
    expect(await detector.detect(evidence, 1_000)).toMatchObject({ state: "unavailable", reason: "failed" })
  }
})

test("missing and crashing executables degrade the diagnostic", async () => {
  const missing = new WafDetector(["/nonexistent/trawl-waf"])
  workers.push(missing)
  expect(await missing.detect(evidence, 1_000)).toMatchObject({ state: "unavailable", reason: "not-installed" })
  expect(await worker("process.exit(1)").detect(evidence, 1_000)).toMatchObject({
    state: "unavailable",
    reason: "failed",
  })
})

test("timeout and cancellation stop a worker without queueing concurrent requests", async () => {
  const detector = worker("await Bun.sleep(60_000)")
  const controller = new AbortController()
  const first = detector.detect(evidence, 1_000, controller.signal)
  expect(await detector.detect(evidence, 1_000)).toMatchObject({ reason: "busy" })
  controller.abort()
  expect(await first).toMatchObject({ reason: "timeout" })
  await detector.close()
  expect(await detector.detect(evidence, 10)).toMatchObject({ reason: "timeout" })
})

test("rejects malformed and oversized worker output", async () => {
  for (const output of ["{}", "x".repeat(33_000)]) {
    const detector = worker(`console.log(${JSON.stringify(output)}); await Bun.sleep(60_000)`)
    expect(await detector.detect(evidence, 1_000)).toMatchObject({ state: "unavailable", reason: "failed" })
  }
})

function deps(detectWaf: OrchestratorDeps["detectWaf"]): OrchestratorDeps {
  return {
    detectWaf,
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
    acquireBrowser: async () => {
      throw new Error("No browser expected")
    },
    releaseBrowser: () => {},
  }
}
const successful = {
  tier1: async () => ({
    tier: 1 as const,
    status: "success" as const,
    durationMs: 0,
    statusCode: 200,
    html: "ordinary page",
    responseHeaders: { server: "cloudflare" },
  }),
}

test("defaults classify when a detector is available", async () => {
  let calls = 0
  const result = await scrape(
    { url: "https://example.test" },
    deps(async () => {
      calls++
      return detection
    }),
    successful,
  )
  expect(result.waf).toEqual({ ...detection, sourceTier: 1 })
  expect(calls).toBe(1)
})

test("per-request opt-out and the deployment switch skip the detector", async () => {
  const fail = async () => {
    throw new Error("Detector must not run")
  }
  const disabled = await scrape({ url: "https://example.test", detectWaf: false }, deps(fail), successful)
  expect(disabled.waf).toBeUndefined()
  const globallyDisabled = await scrape(
    { url: "https://example.test", detectWaf: true },
    { ...deps(fail), wafDetectionEnabled: false },
    successful,
  )
  expect(globallyDisabled.waf).toBeUndefined()
})

test("detects from acquired compressed Tier 1 wall markup even when no html is returned", async () => {
  let observed = ""
  const response = new Response(new Uint8Array(gzipSync(ANUBIS_CHALLENGE)), {
    headers: { "content-type": "text/html", "content-encoding": "gzip" },
  })
  await withFetch(response, async () => {
    await expect(
      scrape(
        { url: "https://example.test", maxTier: 1, detectWaf: true },
        deps(async (input) => {
          observed = input
          return { ...detection, products: ["Anubis (Techaro)"] }
        }),
      ),
    ).rejects.toBeInstanceOf(ScrapeError)
  })
  const captured = JSON.parse(observed)
  expect(Buffer.from(captured.body, "base64").toString()).toBe(ANUBIS_CHALLENGE)
  expect(captured.availability.body).toBe("complete")
})

test("provider identity does not escalate a successful scrape", async () => {
  const result = await scrape(
    { url: "https://example.test", detectWaf: true },
    deps(async () => detection),
    successful,
  )
  expect(result.tier).toBe(1)
  expect(result.html).toBe("ordinary page")
  expect(result.waf).toEqual({ ...detection, sourceTier: 1 })
})

test("detector failures cannot turn a successful scrape into an error", async () => {
  const result = await scrape(
    { url: "https://example.test", detectWaf: true },
    deps(async () => {
      throw new Error("worker failed")
    }),
    successful,
  )
  expect(result.html).toBe("ordinary page")
  expect(result.waf).toMatchObject({ state: "unavailable", reason: "failed" })
})

test("a diagnostic timeout preserves content and includes the wait in totalMs", async () => {
  const detector = worker("await Bun.sleep(60_000)")
  const result = await scrape(
    { url: "https://example.test", maxTimeout: 2_000 },
    deps((input, timeoutMs, signal) => detector.detect(input, timeoutMs, signal)),
    successful,
  )
  expect(result.html).toBe("ordinary page")
  expect(result.waf).toMatchObject({ state: "unavailable", reason: "timeout" })
  expect(result.totalMs).toBeGreaterThanOrEqual(200)
})

test("a failed scrape keeps its error and adds the original response attribution", async () => {
  try {
    await scrape(
      { url: "https://example.test", maxTier: 1, detectWaf: true },
      deps(async () => detection),
      {
        tier1: async () => ({
          tier: 1,
          status: "blocked",
          durationMs: 0,
          statusCode: 403,
          responseHeaders: { server: "cloudflare" },
        }),
      },
    )
    throw new Error("Expected blocked scrape")
  } catch (error) {
    expect(error).toBeInstanceOf(ScrapeError)
    expect((error as ScrapeError).waf).toEqual({ ...detection, sourceTier: 1 })
  }
})
