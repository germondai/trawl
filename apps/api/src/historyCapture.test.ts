import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OrchestratorDeps } from "@trawl/tiers"
import type { ScrapeResult } from "@trawl/types"
import { CaptureStore, defaultCapturePolicy } from "./captureStore"
import { createHistoryCapture } from "./historyCapture"

type Page = Parameters<NonNullable<OrchestratorDeps["captureHistory"]>>[0]
const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 1, 224, 2, 128, 0, 255, 217])
const at = "2026-11-16T10:00:00.000Z"
const result = (tier: 1 | 2 | 3 | 4): ScrapeResult => ({
  url: "https://owned.fixture",
  html: "<p>owned fixture</p>",
  cookies: [],
  userAgent: "fixture",
  statusCode: 200,
  tier,
  sessionCached: false,
  timings: [],
  totalMs: 1,
})
const limits = { width: 640, height: 480, quality: 50, timeoutMs: 5 }
test("active request snapshots share admission limits and release slots when discarded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-request-admission-"))
  const store = new CaptureStore(directory, {
    ...defaultCapturePolicy,
    request: true,
    artifactBytes: 1024,
    totalBytes: 512,
  })
  try {
    await store.ready
    const first = createHistoryCapture(store, { url: "https://owned.fixture/first", body: "x".repeat(100) }, limits)
    const second = createHistoryCapture(store, { url: "https://owned.fixture/second", body: "x".repeat(100) }, limits)
    const denied = createHistoryCapture(store, { url: "https://owned.fixture/denied", body: "x".repeat(100) }, limits)
    denied.commit("denied", at, result(1))
    await store.flush()
    expect(store.manifest("denied", at).artifacts[0]?.reason).toBe("capture-busy")
    first.dispose()
    first.dispose()
    const replacement = createHistoryCapture(store, { url: "https://owned.fixture/replacement" }, limits)
    second.dispose()
    replacement.commit("admitted", at, result(1))
    await store.flush()
    expect(store.manifest("admitted", at).artifacts[0]?.state).toBe("ready")
  } finally {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
test("request-only capture snapshots payloads on success and failure without taking screenshots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-request-history-"))
  const store = new CaptureStore(directory, { ...defaultCapturePolicy, request: true, artifactBytes: 1024 })
  try {
    await store.ready
    const request = {
      url: "https://owned.fixture/path?value=1",
      method: "POST" as const,
      headers: { authorization: "target-fixture-token" },
      body: '{"input":true}',
    }
    const captured = createHistoryCapture(store, request, limits)
    expect(captured.observe).toBeUndefined()
    request.body = "later mutation"
    captured.commit("saved-input", at, result(1))
    createHistoryCapture(store, request, limits).failed("failed-input", at)
    createHistoryCapture(store, { ...request, body: "x".repeat(2000) }, limits).commit("large-input", at, result(1))
    await store.flush()
    expect(store.manifest("saved-input", at).artifacts).toMatchObject([
      { kind: "request", state: "ready", contentType: "application/json" },
    ])
    const value = await store.read("saved-input", at, "request")
    expect(JSON.parse(new TextDecoder().decode(value)).parameters).toMatchObject({
      body: '{"input":true}',
      headers: { authorization: "target-fixture-token" },
    })
    expect(store.manifest("failed-input", at).artifacts[0]?.state).toBe("ready")
    expect(store.manifest("large-input", at).artifacts[0]?.state).toBe("too-large")
    expect(await store.read("large-input", at, "request")).toBeUndefined()
  } finally {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("HTML and HTTP-only history do not ask a browser to take a screenshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-history-"))
  const store = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "both" })
  try {
    await store.ready
    const capture = createHistoryCapture(store, { url: "https://owned.fixture" }, limits)
    capture.commit("http-only", at, result(1))
    await store.flush()
    expect(store.manifest("http-only", at).artifacts.map((value) => [value.kind, value.state])).toEqual([
      ["html", "ready"],
      ["screenshot", "unavailable"],
    ])
    const htmlStore = { ...store, policy: { ...store.policy, mode: "html" } } as unknown as CaptureStore
    expect(createHistoryCapture(htmlStore, { url: "https://owned.fixture" }, limits).observe).toBeUndefined()
  } finally {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("opt-in input capture retains response headers and cookies within its existing byte limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-response-metadata-"))
  const store = new CaptureStore(directory, { ...defaultCapturePolicy, request: true, artifactBytes: 1024 })
  try {
    await store.ready
    const request = { url: "https://owned.fixture", headers: { "x-input": "fixture" } }
    const response = {
      ...result(1),
      responseHeaders: { "x-output": "fixture" },
      cookies: [
        { name: "demo", value: "yes", domain: "owned.fixture", path: "/", expires: -1, httpOnly: false, secure: false },
      ],
    }
    createHistoryCapture(store, request, limits).commit("metadata", at, response)
    createHistoryCapture(store, request, limits).commit("oversized", at, {
      ...response,
      responseHeaders: { large: "x".repeat(2000) },
    })
    await store.flush()
    const saved = async (id: string) => JSON.parse(new TextDecoder().decode(await store.read(id, at, "request")))
    expect(await saved("metadata")).toMatchObject({
      parameters: request,
      response: { headers: response.responseHeaders, cookies: response.cookies },
    })
    expect(await saved("oversized")).toMatchObject({ parameters: request })
    expect((await saved("oversized")).response).toBeUndefined()
  } finally {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("capture uses its actual page without resizing or changing the returned scrape result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-history-"))
  const store = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "both" })
  const calls: unknown[] = []
  const page = {
    viewportSize: () => ({ width: 1920, height: 1080 }),
    screenshot: async (options: unknown) => {
      calls.push(options)
      return jpeg
    },
  } as unknown as Page
  try {
    await store.ready
    const capture = createHistoryCapture(store, { url: "https://owned.fixture" }, limits)
    await capture.observe?.(page, 3, 2000)
    const response = result(3)
    capture.commit("browser", at, response)
    await store.flush()
    expect(calls).toEqual([
      {
        type: "jpeg",
        quality: 50,
        scale: "css",
        caret: "initial",
        timeout: 5,
        clip: { x: 0, y: 0, width: 640, height: 480 },
      },
    ])
    expect(store.manifest("browser", at).artifacts[1]?.state).toBe("ready")
    expect(response.screenshot).toBeUndefined()
    expect(response.html).toBe("<p>owned fixture</p>")
    const reuse = createHistoryCapture(
      store,
      { url: "https://owned.fixture", screenshot: true },
      { ...limits, width: 1920, height: 1080 },
    )
    await reuse.observe?.(page, 3, 1, jpeg.toString("base64"))
    reuse.commit("reuse", at, result(3))
    await store.flush()
    expect(calls).toHaveLength(1)
    expect(store.manifest("reuse", at).artifacts[1]?.state).toBe("ready")
    const short = createHistoryCapture(store, { url: "https://owned.fixture" }, limits)
    await short.observe?.(page, 3, 100)
    short.commit("short-budget", at, result(3))
    await store.flush()
    expect(calls).toHaveLength(1)
    expect(store.manifest("short-budget", at).artifacts[1]?.reason).toBe("insufficient-request-budget")
    const native = createHistoryCapture(store, { url: "https://owned.fixture" }, limits)
    await native.observe?.({ ...page, viewportSize: () => null } as unknown as Page, 3, 2000)
    native.commit("native-viewport", at, result(3))
    await store.flush()
    expect(store.manifest("native-viewport", at).artifacts[1]?.state).toBe("ready")
    expect(calls).toHaveLength(2)
  } finally {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("timed-out screenshots keep their slots until the underlying page operation settles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-history-"))
  const store = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "screenshot" })
  const release: ((bytes: Buffer) => void)[] = []
  let calls = 0
  const page = {
    viewportSize: () => ({ width: 640, height: 480 }),
    screenshot: () => {
      calls++
      return new Promise<Buffer>((resolve) => release.push(resolve))
    },
  } as unknown as Page
  try {
    await store.ready
    const first = createHistoryCapture(store, { url: "https://owned.fixture" }, limits)
    const second = createHistoryCapture(store, { url: "https://owned.fixture" }, limits)
    await Promise.all([first.observe?.(page, 3, 2000), second.observe?.(page, 3, 2000)])
    const third = createHistoryCapture(store, { url: "https://owned.fixture" }, limits)
    await third.observe?.(page, 3, 2000)
    third.commit("busy", at, result(3))
    await store.flush()
    expect(calls).toBe(2)
    expect(store.manifest("busy", at).artifacts[0]?.reason).toBe("capture-busy")
  } finally {
    for (const resolve of release) resolve(jpeg)
    await Promise.resolve()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("failure evidence remains marked as truncated and belongs to the failed request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-history-"))
  const store = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "html" })
  try {
    await store.ready
    createHistoryCapture(store, { url: "https://owned.fixture" }, limits).failed("failed", at, {
      tier: 3,
      status: "blocked",
      url: "https://owned.fixture",
      html: "<p>wall</p>",
      htmlTruncated: true,
    })
    await store.flush()
    expect(store.manifest("failed", at).artifacts[0]).toMatchObject({ state: "ready", truncated: true })
  } finally {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("failure evidence cannot bypass configured screenshot dimensions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trawl-history-"))
  const store = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "screenshot" })
  try {
    await store.ready
    const large = Buffer.from(jpeg)
    large[7] = 5
    large[8] = 220
    const evidence = { tier: 3 as const, status: "blocked" as const, url: "https://owned.fixture", html: "<p>wall</p>" }
    const capture = createHistoryCapture(
      store,
      { url: evidence.url, screenshot: true, screenshotFullPage: true },
      limits,
    )
    capture.failed("oversized-failure", at, { ...evidence, screenshot: large.toString("base64") })
    createHistoryCapture(store, { url: evidence.url }, limits).failed("bounded-failure", at, {
      ...evidence,
      screenshot: jpeg.toString("base64"),
    })
    await store.flush()
    expect(store.manifest("oversized-failure", at).artifacts[0]).toMatchObject({
      state: "unavailable",
      reason: "screenshot-dimensions-limit",
    })
    expect(store.manifest("bounded-failure", at).artifacts[0]?.state).toBe("ready")
  } finally {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
