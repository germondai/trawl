import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { browserExecutable, browserRoot, browserStatus } from "../src/browser"
import { browserVersion } from "../src/browser-assets"
import { startControl } from "../src/control"
import { manage } from "../src/management"
import { type RuntimePaths, runtimePaths } from "../src/paths"

async function fixture(paths: RuntimePaths) {
  const files = [
    browserExecutable(paths.browser),
    join(paths.browser, "GeoLite2-City.mmdb"),
    join(paths.browser, "version.json"),
    join(browserRoot(paths.browser), "addons/UBO/manifest.json"),
  ]
  for (const file of files) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, "owned fixture")
  }
  await writeFile(
    join(paths.browser, "trawl-browser.json"),
    JSON.stringify({ version: browserVersion, platform: process.platform, arch: process.arch, securityBackport: true }),
  )
}
test("browser status distinguishes missing, supported, older and incomplete installations", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-browser-state-"))
  const paths = runtimePaths(home)
  try {
    expect(await browserStatus(paths)).toMatchObject({
      installed: false,
      state: "not-installed",
      supportedVersion: browserVersion,
    })
    await fixture(paths)
    expect(await browserStatus(paths)).toMatchObject({ installed: true, state: "ready", version: browserVersion })
    const marker = join(paths.browser, "trawl-browser.json")
    const original = await readFile(marker, "utf8")
    await writeFile(marker, JSON.stringify({ ...JSON.parse(original), version: "old-supported-build" }))
    expect(await browserStatus(paths)).toMatchObject({
      installed: false,
      state: "update-available",
      version: "old-supported-build",
    })
    await writeFile(marker, original)
    await rm(join(paths.browser, "GeoLite2-City.mmdb"))
    expect(await browserStatus(paths)).toMatchObject({ installed: false, state: "repair-needed" })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
test("browser management preserves active installations and uninstalls only managed browser data", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-browser-remove-"))
  const paths = runtimePaths(home)
  let close: (() => Promise<void>) | undefined
  try {
    await fixture(paths)
    await writeFile(paths.config, "settings stay")
    close = await startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})
    for (const action of ["uninstallBrowser", "repairBrowser"])
      await expect(manage({ action, home })).rejects.toThrow("Stop the managed server")
    expect((await browserStatus(paths)).installed).toBe(true)
    await close()
    close = undefined
    expect(await manage({ action: "uninstallBrowser", home })).toMatchObject({
      installed: false,
      state: "not-installed",
    })
    expect(await readFile(paths.config, "utf8")).toBe("settings stay")
    expect(await manage({ action: "uninstallBrowser", home })).toMatchObject({ installed: false })
  } finally {
    await close?.()
    await rm(home, { recursive: true, force: true })
  }
})
