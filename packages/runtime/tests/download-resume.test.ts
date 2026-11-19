import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadVerified } from "../src/assets"

const content = Buffer.from("owned pinned archive bytes for resume")
const asset = {
  url: "https://example.invalid/browser.zip",
  size: content.length,
  sha256: createHash("sha256").update(content).digest("hex"),
}
for (const mode of ["range", "restart", "corrupt"] as const)
  test(`interrupted downloads ${mode === "range" ? "resume verified ranges" : mode === "restart" ? "restart when range is ignored" : "reject a corrupt continuation"}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "trawl-resume-")),
      destination = join(home, "archive.zip")
    let attempt = 0
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_url: unknown, init?: RequestInit) => {
          attempt++
          if (attempt === 1) return new Response(content.subarray(0, 8), { headers: { etag: '"owned"' } })
          expect(new Headers(init?.headers).get("range")).toBe("bytes=8-")
          expect(new Headers(init?.headers).get("if-range")).toBe('"owned"')
          if (mode === "restart") return new Response(content, { headers: { etag: '"owned"' } })
          return new Response(mode === "corrupt" ? Buffer.alloc(content.length - 8, 65) : content.subarray(8), {
            status: 206,
            headers: { "content-range": `bytes 8-${content.length - 1}/${content.length}`, etag: '"owned"' },
          })
        },
        { preconnect: fetch.preconnect },
      ),
    )
    try {
      await expect(downloadVerified(asset, destination, undefined, undefined, { resume: true })).rejects.toThrow(
        "retry to resume",
      )
      expect(await readFile(destination + ".partial")).toEqual(content.subarray(0, 8))
      if (mode === "corrupt")
        await expect(downloadVerified(asset, destination, undefined, undefined, { resume: true })).rejects.toThrow(
          "SHA-256",
        )
      else {
        await downloadVerified(asset, destination, undefined, undefined, { resume: true })
        expect(await readFile(destination)).toEqual(content)
      }
      expect((await readdir(home)).some((name) => name.includes("partial"))).toBe(false)
    } finally {
      fetcher.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })
