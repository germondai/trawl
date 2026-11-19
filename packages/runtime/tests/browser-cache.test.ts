import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { browserAssets, browserVersion } from "../src/browser-assets"
import { discardBrowserDownload, pruneBrowserDownloads } from "../src/browser-cache"
import { installExclusive } from "../src/install-lock"
import { runtimePaths } from "../src/paths"

test("manual cancellation discards its cached archive while pruning respects live jobs and other files", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-browser-cache-")),
    paths = runtimePaths(home)
  const asset = browserAssets[`${process.platform}-${process.arch}`]!
  const downloads = join(home, "downloads"),
    archive = `${asset.sha256}.zip`
  const stage = join(home, "browser.stage-11111111-1111-1111-1111-111111111111")
  try {
    await mkdir(downloads)
    await mkdir(join(home, "browsers"))
    await mkdir(stage)
    for (const suffix of ["", ".partial", ".partial.json"])
      await writeFile(join(downloads, archive + suffix), "owned cache")
    await writeFile(join(downloads, "keep"), "unrelated")
    await discardBrowserDownload(paths, browserVersion)
    expect(await readdir(downloads)).toEqual(["keep"])
    await writeFile(join(downloads, archive + ".partial"), "old partial")
    const old = new Date(Date.now() - 25 * 3600000)
    await utimes(join(downloads, archive + ".partial"), old, old)
    await utimes(stage, old, old)
    await installExclusive(join(home, "browsers", browserVersion), async () => {
      await pruneBrowserDownloads(paths)
      expect(await readFile(join(downloads, archive + ".partial"), "utf8")).toBe("old partial")
    })
    await pruneBrowserDownloads(paths)
    expect(await readdir(downloads)).toEqual(["keep"])
    expect((await readdir(home)).some((name) => name.includes(".stage-"))).toBe(false)
    // A cache link is removed without touching the external target.
    const external = join(home, "external")
    await writeFile(external, "keep external")
    await symlink(external, join(downloads, archive + ".partial"))
    await discardBrowserDownload(paths, browserVersion)
    expect(await readFile(external, "utf8")).toBe("keep external")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
