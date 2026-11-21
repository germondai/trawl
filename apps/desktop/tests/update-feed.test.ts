import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildUpdateFeed } from "../scripts/update-feed"

test("release feed rejects unsigned packages and keeps architecture-specific URLs", async () => {
  const folder = await mkdtemp(join(tmpdir(), "trawl-feed-"))
  try {
    const name = "TRAWL_0.1.1_darwin-aarch64.app.tar.gz"
    await writeFile(join(folder, name), "fixture archive")
    await expect(buildUpdateFeed("0.1.1", folder)).rejects.toThrow("signature")
    await writeFile(join(folder, `${name}.sig`), "Zml4dHVyZQ==")
    const feed = await buildUpdateFeed("0.1.1", folder)
    expect(feed.platforms["darwin-aarch64"]?.url).toBe(
      `https://github.com/germondai/trawl/releases/download/v0.1.1/${name}`,
    )
    expect(feed.platforms["darwin-x86_64"]).toBeUndefined()
    await expect(buildUpdateFeed("../invalid", folder)).rejects.toThrow("version")
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
