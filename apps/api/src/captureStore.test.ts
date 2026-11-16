import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { type CapturePolicy, CaptureStore, defaultCapturePolicy } from "./captureStore"

const at = "2026-11-16T10:00:00.000Z"
function fixture(overrides: Partial<CapturePolicy> = {}, clock?: () => number) {
  const directory = mkdtempSync(join(tmpdir(), "trawl-captures-"))
  const policy = { ...defaultCapturePolicy, mode: "html" as const, ...overrides }
  const store = new CaptureStore(directory, policy, clock)
  return {
    directory,
    policy,
    store,
    async close() {
      await store.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

describe("bounded private request captures", () => {
  test("restart permits the maximum two-artifact file count plus SQLite files", async () => {
    const f = fixture({ records: 5000 })
    try {
      await f.store.ready
      await f.store.close()
      for (let index = 0; index < 5000; index++)
        for (const kind of ["html", "screenshot"])
          writeFileSync(join(f.directory, `orphan-${index}.${kind}.capture`), "")
      const reopened = new CaptureStore(f.directory, f.policy)
      try {
        await reopened.ready
        expect(reopened.available).toBe(true)
        expect(readdirSync(f.directory).some((name) => name.endsWith(".capture"))).toBe(false)
      } finally {
        await reopened.close()
      }
    } finally {
      await f.close()
    }
  })
  test("an existing foreign directory or database is left untouched", async () => {
    const directory = mkdtempSync(join(tmpdir(), "trawl-foreign-captures-"))
    const path = join(directory, "unrelated.html.capture")
    writeFileSync(path, "owned unrelated fixture")
    const store = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "html" })
    try {
      await store.ready
      expect(store.available).toBe(false)
      expect(readFileSync(path, "utf8")).toBe("owned unrelated fixture")
      expect(existsSync(join(directory, "index.sqlite"))).toBe(false)
      const db = new Database(join(directory, "index.sqlite"))
      db.run("CREATE TABLE unrelated(value TEXT)")
      db.run("INSERT INTO unrelated VALUES('owned unrelated row')")
      db.close()
      const second = new CaptureStore(directory, { ...defaultCapturePolicy, mode: "html" })
      await second.ready
      expect(second.available).toBe(false)
      const inspected = new Database(join(directory, "index.sqlite"), { readonly: true })
      expect(inspected.query("SELECT value FROM unrelated").get()).toEqual({ value: "owned unrelated row" })
      expect(inspected.query("SELECT name FROM sqlite_master WHERE name='captures'").get()).toBeNull()
      inspected.close()
      await second.close()
    } finally {
      await store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  test("metadata-only defaults create no artifact files or database", async () => {
    const directory = join(mkdtempSync(join(tmpdir(), "trawl-capture-off-")), "absent")
    const store = new CaptureStore(directory)
    try {
      await store.ready
      store.capture({ requestId: "request-off", requestAt: at, html: "hello" })
      await store.flush()
      expect(existsSync(directory)).toBe(false)
      expect(store.manifest("request-off", at).artifacts).toEqual([])
    } finally {
      await store.close()
      rmSync(join(directory, ".."), { recursive: true, force: true })
    }
  })

  test("HTML is compressed, integrity checked and readable after a metadata-only restart", async () => {
    const f = fixture({ mode: "both" })
    let reopened: CaptureStore | undefined
    try {
      await f.store.ready
      const html = `<html>${"Owned content. ".repeat(1000)}</html>`
      const screenshot = Uint8Array.from([255, 216, 255, 224, 0, 2, 255, 217])
      f.store.capture({ requestId: "request-one", requestAt: at, html, screenshot })
      await f.store.flush()
      const manifest = f.store.manifest("request-one", at)
      expect(manifest.artifacts.map((value) => value.state)).toEqual(["ready", "ready"])
      expect(manifest.artifacts[0]?.storedBytes).toBeLessThan(Buffer.byteLength(html))
      expect(new TextDecoder().decode(await f.store.read("request-one", at, "html"))).toBe(html)
      expect(await f.store.read("request-one", at, "screenshot")).toEqual(screenshot)
      expect(statSync(join(f.directory, "request-one.html.capture")).mode & 0o777).toBe(0o600)
      await f.store.close()
      reopened = new CaptureStore(f.directory)
      await reopened.ready
      expect(new TextDecoder().decode(await reopened.read("request-one", at, "html"))).toBe(html)
      expect(reopened.manifest("request-one", "2026-11-17T10:00:00.000Z").artifacts).toEqual([])
    } finally {
      await reopened?.close()
      await f.close()
    }
  })

  test("content and queue limits preserve scrape callers and do not evict for an unavailable snapshot", async () => {
    const f = fixture({ mode: "both", artifactBytes: 32, totalBytes: 64, records: 1 })
    try {
      await f.store.ready
      f.store.capture({ requestId: "first", requestAt: at, html: "first", screenshot: new Uint8Array(8) })
      await f.store.flush()
      f.store.capture({ requestId: "unavailable", requestAt: at })
      await f.store.flush()
      expect(f.store.manifest("first", at).artifacts[0]?.state).toBe("ready")
      expect(f.store.manifest("unavailable", at).artifacts.map((value) => value.state)).toEqual([
        "unavailable",
        "unavailable",
      ])
      f.store.capture({ requestId: "oversized", requestAt: at, html: "x".repeat(33) })
      await f.store.flush()
      expect(f.store.manifest("oversized", at).artifacts[0]?.state).toBe("too-large")
      const calls = Array.from({ length: 20 }, (_, index) => ({
        requestId: `burst-${index}`,
        requestAt: at,
        html: "x".repeat(20),
        screenshot: new Uint8Array(20),
      }))
      for (const input of calls) expect(() => f.store.capture(input)).not.toThrow()
      await f.store.flush()
      expect(
        calls.some((input) =>
          f.store.manifest(input.requestId, at).artifacts.some((value) => value.reason === "capture-queue-limit"),
        ),
      ).toBe(true)
      expect(readdirSync(f.directory).filter((name) => name.endsWith(".capture")).length).toBeLessThanOrEqual(2)
      expect(readdirSync(f.directory).some((name) => name.endsWith(".tmp"))).toBe(false)
    } finally {
      await f.close()
    }
  })

  test("quota eviction removes files and preserves an explicit expired manifest", async () => {
    const f = fixture({ mode: "screenshot", artifactBytes: 8, totalBytes: 16, records: 2 })
    try {
      await f.store.ready
      for (const id of ["one", "two", "three"]) {
        f.store.capture({ requestId: id, requestAt: at, screenshot: new Uint8Array(8) })
        await f.store.flush()
      }
      expect(f.store.manifest("one", at).artifacts[0]).toMatchObject({ state: "expired", reason: "storage-quota" })
      expect(await f.store.read("one", at, "screenshot")).toBeUndefined()
      const paths = readdirSync(f.directory).filter((name) => name.endsWith(".capture"))
      expect(paths.reduce((size, name) => size + statSync(join(f.directory, name)).size, 0)).toBeLessThanOrEqual(16)
    } finally {
      await f.close()
    }
  })

  test("screenshot fallback is explicit and also applies to an oversized image", async () => {
    const f = fixture({ mode: "screenshot", fallbackHtml: true, artifactBytes: 8, totalBytes: 16 })
    try {
      await f.store.ready
      f.store.capture({ requestId: "fallback", requestAt: at, html: "hello", screenshot: new Uint8Array(9) })
      await f.store.flush()
      expect(f.store.manifest("fallback", at).artifacts.map((value) => [value.kind, value.state])).toEqual([
        ["html", "ready"],
        ["screenshot", "too-large"],
      ])
    } finally {
      await f.close()
    }
  })

  test("retention and interrupted-write recovery remove bytes without changing old request IDs", async () => {
    let time = Date.parse(at)
    const f = fixture({ retentionMs: 1000 }, () => time)
    let reopened: CaptureStore | undefined
    try {
      await f.store.ready
      f.store.capture({ requestId: "old", requestAt: at, html: "saved" })
      await f.store.flush()
      await f.store.close()
      const db = new Database(join(f.directory, "index.sqlite"))
      const interrupted = {
        requestId: "pending",
        requestAt: at,
        mode: "html",
        artifacts: [{ kind: "html", state: "pending" }],
      }
      db.query("INSERT INTO captures VALUES(?,?,?,?,?,?,?,?)").run(
        "pending",
        at,
        time,
        "html",
        JSON.stringify(interrupted),
        0,
        0,
        1,
      )
      db.close()
      writeFileSync(join(f.directory, "pending.html.tmp"), "partial")
      writeFileSync(join(f.directory, "orphan.html.capture"), "orphan")
      time += 2000
      reopened = new CaptureStore(f.directory, f.policy, () => time)
      await reopened.ready
      expect(reopened.manifest("old", at).artifacts[0]?.state).toBe("expired")
      expect(reopened.manifest("pending", at).artifacts[0]).toMatchObject({
        state: "failed",
        reason: "interrupted-write",
      })
      expect(readdirSync(f.directory).filter((name) => name.endsWith(".tmp") || name.endsWith(".capture"))).toEqual([])
    } finally {
      await reopened?.close()
      await f.close()
    }
  })

  test("bounded decompression, integrity and no-follow reads reject replaced artifacts", async () => {
    const f = fixture({ artifactBytes: 1024 })
    try {
      await f.store.ready
      f.store.capture({ requestId: "integrity", requestAt: at, html: "original" })
      await f.store.flush()
      const path = join(f.directory, "integrity.html.capture")
      writeFileSync(path, "tampered")
      expect(await f.store.read("integrity", at, "html")).toBeUndefined()
      await f.store.flush()
      expect(f.store.manifest("integrity", at).artifacts[0]?.state).toBe("failed")
      f.store.capture({ requestId: "link", requestAt: at, html: "original" })
      await f.store.flush()
      const target = join(f.directory, "owned-fixture.txt")
      writeFileSync(target, "owned fixture only")
      unlinkSync(join(f.directory, "link.html.capture"))
      symlinkSync(target, join(f.directory, "link.html.capture"))
      expect(await f.store.read("link", at, "html")).toBeUndefined()
      await f.store.flush()
      expect(readFileSync(target, "utf8")).toBe("owned fixture only")
      const compressed = gzipSync(Buffer.from("x".repeat(100000)))
      expect(() => gunzipSync(compressed, { maxOutputLength: 11 })).toThrow()
      expect(await f.store.read("../owned-fixture", at, "html")).toBeUndefined()
    } finally {
      await f.close()
    }
  })
})
