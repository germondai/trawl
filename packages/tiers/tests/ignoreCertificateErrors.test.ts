import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserHandle } from "@trawl/types"
import type { OrchestratorDeps } from "../src/orchestrator"
import { scrape } from "../src/orchestrator"
import { runTier1 } from "../src/tiers/1"
import { runTier3 } from "../src/tiers/3"
import { runTier4 } from "../src/tiers/4"

// A self-signed certificate nothing trusts. Minted per run rather than committed so no
// private key ever lands in the repository.
let certDir: string
let server: ReturnType<typeof Bun.serve>
let baseUrl: string

const PAGE = "<html><body>content behind an untrusted certificate</body></html>"

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), "trawl-selfsigned-"))
  const keyPath = join(certDir, "key.pem")
  const certPath = join(certDir, "cert.pem")
  const openssl = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=localhost",
  ])
  if (!openssl.success) throw new Error(`openssl could not mint the test certificate: ${openssl.stderr.toString()}`)

  server = Bun.serve({
    port: 0,
    tls: { key: Bun.file(keyPath), cert: Bun.file(certPath) },
    fetch: () => new Response(PAGE, { headers: { "Content-Type": "text/html" } }),
  })
  baseUrl = `https://localhost:${server.port}/`
})

afterAll(() => {
  server.stop(true)
  rmSync(certDir, { recursive: true, force: true })
})

const noBrowserDeps: OrchestratorDeps = {
  acquireBrowser: async () => {
    throw new Error("Tier 1 should settle this request without a browser")
  },
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
}

// Fake browser whose context creation records the options a tier asked for, then fails page
// creation so the tier returns immediately.
const recordingHandle = () => {
  const seen: Record<string, unknown>[] = []
  const context = {
    addInitScript: async () => {},
    newPage: async () => {
      throw new Error("page creation failed")
    },
    close: async () => {},
  }
  const handle: BrowserHandle = {
    id: 0,
    lease: 1,
    headful: false,
    context: {},
    browser: {
      newContext: async (options: Record<string, unknown>) => {
        seen.push(options)
        return context
      },
    },
    fingerprint: { userAgent: "test", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
  }
  return { handle, seen }
}

describe("ignoreCertificateErrors", () => {
  test("an invalid certificate is a hard failure by default", async () => {
    const result = await runTier1(baseUrl)

    expect(result.status).toBe("error")
    expect(result.reason).toMatch(/self[- ]signed certificate/i)
    await expect(scrape({ url: baseUrl, maxTier: 1 }, noBrowserDeps)).rejects.toThrow()
  })

  test("the opted-in request loads the page and reports why the certificate was rejected", async () => {
    const result = await runTier1(baseUrl, undefined, undefined, undefined, undefined, undefined, true)

    expect(result.status).toBe("success")
    expect(result.html).toContain("content behind an untrusted certificate")
    expect(result.certificateError).toContain("DEPTH_ZERO_SELF_SIGNED_CERT")
  })

  test("the orchestrator returns the page with the certificate failure attached", async () => {
    const result = await scrape({ url: baseUrl, maxTier: 1, ignoreCertificateErrors: true }, noBrowserDeps)

    expect(result.html).toContain("content behind an untrusted certificate")
    expect(result.statusCode).toBe(200)
    expect(result.certificateError).toContain("DEPTH_ZERO_SELF_SIGNED_CERT")
  })

  test("one opted-in request does not relax verification for the next request", async () => {
    await scrape({ url: baseUrl, maxTier: 1, ignoreCertificateErrors: true }, noBrowserDeps)

    const strict = await runTier1(baseUrl)
    expect(strict.status).toBe("error")
    expect(strict.certificateError).toContain("DEPTH_ZERO_SELF_SIGNED_CERT")
    const result = await scrape({ url: baseUrl, maxTier: 1 }, noBrowserDeps)
      .then(() => "resolved")
      .catch(() => "rejected")
    expect(result).toBe("rejected")
  })

  test("a request with no certificate failure is made once, with no unverified retry", async () => {
    let requests = 0
    const plain = Bun.serve({
      port: 0,
      fetch: () => {
        requests++
        return new Response(PAGE, { headers: { "Content-Type": "text/html" } })
      },
    })
    try {
      const result = await runTier1(
        `http://127.0.0.1:${plain.port}/`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      )
      expect(result.status).toBe("success")
      expect(result.certificateError).toBeUndefined()
      expect(requests).toBe(1)
    } finally {
      plain.stop(true)
    }
  })

  test("Tier 3 relaxes verification only for the opted-in request's own context", async () => {
    const optedIn = recordingHandle()
    await runTier3(
      "https://example.com",
      optedIn.handle,
      1_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      true,
    )
    expect(optedIn.seen[0]).toMatchObject({ ignoreHTTPSErrors: true })

    const def = recordingHandle()
    await runTier3("https://example.com", def.handle, 1_000)
    expect(def.seen[0]).not.toHaveProperty("ignoreHTTPSErrors")
  })

  test("Tier 4 relaxes verification only for the opted-in request's own context", async () => {
    const optedIn = recordingHandle()
    const proxy = "http://proxy.example:8080"
    await runTier4(
      "https://example.com",
      optedIn.handle,
      1_000,
      proxy,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      true,
    )
    expect(optedIn.seen[0]).toMatchObject({ ignoreHTTPSErrors: true })

    const def = recordingHandle()
    await runTier4("https://example.com", def.handle, 1_000, proxy)
    expect(def.seen[0]).not.toHaveProperty("ignoreHTTPSErrors")
  })

  test("Tier 2 is skipped rather than replayed inside the shared pool context", async () => {
    const attempts: string[] = []
    await scrape(
      { url: baseUrl, maxTier: 2, ignoreCertificateErrors: true, skipHttp: true },
      {
        ...noBrowserDeps,
        acquireBrowser: async () => recordingHandle().handle,
        releaseBrowser: () => {},
        loadSession: async () => ({ cookies: [], userAgent: "cached-agent", savedAt: 1 }),
        onTierAttempt: (result) => attempts.push(`${result.tier}:${result.status}:${result.reason ?? ""}`),
      },
    ).catch(() => {})

    expect(attempts).toContain("2:skipped:ignore-certificate-errors-needs-fresh-context")
  })
})
