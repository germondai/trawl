import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { browserExecutable, browserRoot, browserStatus, installBrowser } from "../src/browser"
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
    expect((await browserStatus(paths)).choices.some((choice) => choice.version === browserVersion)).toBe(true)
    await expect(manage({ action: "installBrowser", home, browserVersion: "unsupported-build" })).rejects.toThrow(
      "Unsupported browser build",
    )
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
test("browser imports reject unsupported, nested and linked sources without changing the installed browser", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-browser-import-"))
  const paths = runtimePaths(home)
  const source = runtimePaths(join(home, "source"))
  try {
    await fixture(paths)
    await fixture(source)
    const metadata = join(source.browser, "version.json")
    await writeFile(metadata, JSON.stringify({ version: "unsupported", release: "build" }))
    await expect(installBrowser(paths, undefined, { source: source.browser })).rejects.toThrow("not supported")
    await expect(installBrowser(paths, undefined, { source: "relative" })).rejects.toThrow("absolute")
    await expect(installBrowser(paths, undefined, { source: paths.browser })).rejects.toThrow("outside")
    await expect(installBrowser(paths, undefined, { source: join(paths.browser, "nested") })).rejects.toThrow("outside")
    const [version, release] = browserVersion.split("-")
    await writeFile(metadata, JSON.stringify({ version, release }))
    await symlink(paths.config, join(source.browser, "external-link"))
    await expect(installBrowser(paths, undefined, { source: source.browser })).rejects.toThrow("links or special")
    await rm(join(source.browser, "external-link"))
    await writeFile(browserExecutable(source.browser), "")
    await expect(installBrowser(paths, undefined, { source: source.browser })).rejects.toThrow("executable")
    await writeFile(browserExecutable(source.browser), "owned fixture")
    await expect(installBrowser(paths, undefined, { source: source.browser })).rejects.toThrow()
    expect(await browserStatus(paths)).toMatchObject({ installed: true, version: browserVersion })
    expect(await readFile(metadata, "utf8")).toBe(JSON.stringify({ version, release }))
    expect((await readdir(home)).some((name) => name.includes(".stage-"))).toBe(false)
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

test("managed browser versions switch without downloads and keep other installed builds", async () => {
  const { supportedBrowsers } = await import("../src/browser-assets")
  const { MODEL_PIN } = await import("fpgen-js")
  const versions = supportedBrowsers.filter((build) => build.assets[`${process.platform}-${process.arch}`])
  const other = versions.find((build) => build.version !== browserVersion)
  if (!other) return
  const home = await mkdtemp(join(tmpdir(), "trawl-browser-library-"))
  const paths = runtimePaths(home)
  try {
    await fixture(paths)
    const slot = join(home, "browsers", other.version)
    await fixture({ ...paths, browser: slot })
    await writeFile(
      join(slot, "trawl-browser.json"),
      JSON.stringify({
        version: other.version,
        platform: process.platform,
        arch: process.arch,
        securityBackport: true,
      }),
    )
    if (other.launcher === "official") {
      for (const file of [...MODEL_PIN.files, "values.dat", ".pinned-model"]) {
        await mkdir(dirname(join(slot, "fpgen", file)), { recursive: true })
        await writeFile(join(slot, "fpgen", file), file === ".pinned-model" ? MODEL_PIN.sha256 : "owned model fixture")
      }
    }
    expect((await browserStatus(paths)).choices.find((choice) => choice.version === other.version)).toMatchObject({
      installed: true,
      active: false,
    })
    const close = await startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})
    try {
      await expect(manage({ action: "activateBrowser", home, browserVersion: other.version })).rejects.toThrow(
        "Stop the managed server",
      )
      expect((await browserStatus(paths)).version).toBe(browserVersion)
    } finally {
      await close()
    }
    await manage({ action: "activateBrowser", home, browserVersion: other.version })
    expect(await browserStatus(paths)).toMatchObject({ installed: true, version: other.version })
    expect((await browserStatus(paths)).choices.find((choice) => choice.version === browserVersion)).toMatchObject({
      installed: true,
      active: false,
    })
    await manage({ action: "activateBrowser", home, browserVersion })
    expect((await browserStatus(paths)).version).toBe(browserVersion)
    await manage({ action: "uninstallBrowser", home, browserVersion: other.version })
    expect(await browserStatus(paths)).toMatchObject({ installed: true, version: browserVersion })
    expect((await browserStatus(paths)).choices.find((choice) => choice.version === other.version)?.installed).toBe(
      false,
    )
    await expect(manage({ action: "activateBrowser", home, browserVersion: "../outside" })).rejects.toThrow(
      "Unsupported",
    )
    await symlink(paths.browser, slot)
    expect((await browserStatus(paths)).choices.find((choice) => choice.version === other.version)?.installed).toBe(
      false,
    )
    await expect(manage({ action: "activateBrowser", home, browserVersion: other.version })).rejects.toThrow(
      "Install or repair",
    )
    expect((await browserStatus(paths)).installed).toBe(true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("browser detection uses only managed folders and leaves former external registrations untouched", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-managed-browser-"))
  const paths = runtimePaths(home)
  const external = runtimePaths(join(home, "external"))
  try {
    await fixture(external)
    const registry = JSON.stringify({
      active: external.browser,
      installations: [{ path: external.browser, version: browserVersion }],
    })
    await writeFile(join(home, "browser-links.json"), registry)
    expect(await browserStatus(paths)).toMatchObject({ installed: false, path: paths.browser })
    await fixture(paths)
    expect(await browserStatus(paths)).toMatchObject({ installed: true, path: paths.browser, version: browserVersion })
    for (const action of ["linkBrowser", "activateLinkedBrowser", "unlinkBrowser"])
      await expect(manage({ action, home, source: external.browser })).rejects.toThrow("Unknown management operation")
    await manage({ action: "uninstallBrowser", home, browserVersion })
    expect(await readFile(browserExecutable(external.browser), "utf8")).toBe("owned fixture")
    expect(await readFile(join(home, "browser-links.json"), "utf8")).toBe(registry)
    expect((await browserStatus(paths)).installed).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("different browser downloads run together while the managed server remains available and cancel independently", async () => {
  const { supportedBrowsers } = await import("../src/browser-assets")
  const builds = supportedBrowsers
    .filter((build) => build.version !== browserVersion && build.assets[`${process.platform}-${process.arch}`])
    .slice(0, 2)
  if (builds.length !== 2) return
  const home = await mkdtemp(join(tmpdir(), "trawl-parallel-browser-"))
  const paths = runtimePaths(home)
  const aborts = builds.map(() => new AbortController())
  const started = new Set<string>()
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => new Response(new ReadableStream({ start() {} })), { preconnect: fetch.preconnect }),
  )
  let close: (() => Promise<void>) | undefined
  let jobs: Promise<unknown>[] = []
  try {
    await fixture(paths)
    close = await startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})
    jobs = builds.map((build, index) =>
      installBrowser(paths, aborts[index]!.signal, {
        version: build.version,
        activate: false,
        progress: (step) => {
          if (step.phase === "download") started.add(build.version)
        },
      }).catch((error) => error),
    )
    const deadline = Date.now() + 1500
    while (started.size < 2 && Date.now() < deadline) await Bun.sleep(10)
    expect(started.size).toBe(2)
    await close()
    close = undefined
    await expect(manage({ action: "clearStorage", storage: "downloads", home })).rejects.toThrow("Another installation")
    close = await startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})
    aborts[0]!.abort()
    await jobs[0]
    expect(aborts[1]!.signal.aborted).toBe(false)
    expect(((await manage({ action: "status", home })) as { running: boolean }).running).toBe(true)
    expect((await browserStatus(paths)).version).toBe(browserVersion)
  } finally {
    for (const abort of aborts) abort.abort()
    await Promise.allSettled(jobs)
    fetcher.mockRestore()
    await close?.()
    expect((await readdir(home)).some((name) => name.includes(".stage-"))).toBe(false)
    await rm(home, { recursive: true, force: true })
  }
})

test("completed background repairs leave the running browser in place until explicit activation", async () => {
  const { finishBrowserInstall } = await import("../src/browser")
  const home = await mkdtemp(join(tmpdir(), "trawl-browser-publish-"))
  const paths = runtimePaths(home)
  const prepared = join(home, "prepared")
  let close: (() => Promise<void>) | undefined
  try {
    await fixture(paths)
    await fixture({ ...paths, browser: prepared })
    await writeFile(browserExecutable(prepared), "repaired fixture")
    close = await startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})
    await finishBrowserInstall(paths, prepared, browserVersion, false)
    expect(await readFile(browserExecutable(paths.browser), "utf8")).toBe("owned fixture")
    expect((await browserStatus(paths)).choices.find((choice) => choice.version === browserVersion)?.pending).toBe(true)
    await close()
    close = undefined
    await manage({ action: "activateBrowser", home, browserVersion })
    expect(await readFile(browserExecutable(paths.browser), "utf8")).toBe("repaired fixture")
    expect((await browserStatus(paths)).choices.find((choice) => choice.version === browserVersion)?.pending).toBe(
      false,
    )
  } finally {
    await close?.()
    await rm(home, { recursive: true, force: true })
  }
})

test("removing an active version also removes its prepared repair", async () => {
  const { finishBrowserInstall } = await import("../src/browser")
  const home = await mkdtemp(join(tmpdir(), "trawl-browser-remove-repair-"))
  const paths = runtimePaths(home)
  try {
    await fixture(paths)
    const prepared = join(home, "prepared")
    await fixture({ ...paths, browser: prepared })
    await finishBrowserInstall(paths, prepared, browserVersion, false)
    await manage({ action: "uninstallBrowser", home, browserVersion })
    expect((await browserStatus(paths)).choices.find((choice) => choice.version === browserVersion)).toMatchObject({
      installed: false,
      pending: false,
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("unsupported and unknown managed folders remain visible and can be removed by identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-unknown-browser-"))
  const paths = runtimePaths(home)
  const old = join(home, "browsers", "retired-build")
  const unknown = join(home, "browsers", "unrecognized")
  const external = join(home, "external")
  let close: (() => Promise<void>) | undefined
  try {
    await fixture(paths)
    await mkdir(old, { recursive: true })
    await writeFile(join(old, "trawl-browser.json"), JSON.stringify({ version: "100.0-deprecated" }))
    await mkdir(unknown)
    await mkdir(external)
    await writeFile(join(external, "keep"), "external files stay")
    await symlink(external, join(home, "browsers", "linked-unknown"))
    let status = await browserStatus(paths)
    expect(status.choices.find((choice) => choice.id === "stored:retired-build")).toMatchObject({
      supported: false,
      state: "update-available",
      version: "100.0-deprecated",
    })
    expect(status.choices.find((choice) => choice.id === "stored:unrecognized")).toMatchObject({
      supported: false,
      state: "unknown",
    })
    close = await startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})
    await expect(manage({ action: "uninstallBrowser", home, browserId: "stored:retired-build" })).rejects.toThrow(
      "Stop the managed server",
    )
    await close()
    close = undefined
    for (const browserId of ["stored:../outside", "stored:..", "anything", "stored:a/b", "stored:a\\b"])
      await expect(manage({ action: "uninstallBrowser", home, browserId })).rejects.toThrow(
        "Invalid managed browser ID",
      )
    // Displayed marker versions cannot redirect removal to the active installation.
    await writeFile(join(old, "trawl-browser.json"), JSON.stringify({ version: browserVersion }))
    await manage({ action: "uninstallBrowser", home, browserVersion, browserId: "stored:retired-build" })
    await manage({ action: "uninstallBrowser", home, browserId: "stored:unrecognized" })
    await manage({ action: "uninstallBrowser", home, browserId: "stored:linked-unknown" })
    expect((await browserStatus(paths)).installed).toBe(true)
    expect(await readFile(join(external, "keep"), "utf8")).toBe("external files stay")
    await writeFile(join(paths.browser, "trawl-browser.json"), JSON.stringify({ version: "old-active" }))
    status = await browserStatus(paths)
    expect(status.choices.find((choice) => choice.id === "active")).toMatchObject({
      active: true,
      supported: false,
      version: "old-active",
    })
    await manage({ action: "uninstallBrowser", home, browserId: "active" })
    expect((await browserStatus(paths)).state).toBe("not-installed")
  } finally {
    await close?.()
    await rm(home, { recursive: true, force: true })
  }
})

test("removing an active browser preserves a different unsupported build found in its former cache slot", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-browser-identity-")),
    paths = runtimePaths(home)
  try {
    await fixture(paths)
    const slot = join(home, "browsers", browserVersion)
    await mkdir(slot, { recursive: true })
    await writeFile(join(slot, "trawl-browser.json"), JSON.stringify({ version: "old-unrelated-build" }))
    expect(
      (await browserStatus(paths)).choices.find((choice) => choice.id === `stored:${browserVersion}`),
    ).toMatchObject({ supported: false, version: "old-unrelated-build" })
    await manage({ action: "uninstallBrowser", home, browserId: "active" })
    expect(
      (await browserStatus(paths)).choices.find((choice) => choice.id === `stored:${browserVersion}`),
    ).toMatchObject({ supported: false, version: "old-unrelated-build" })
    await manage({ action: "uninstallBrowser", home, browserId: `stored:${browserVersion}` })
    expect(
      (await browserStatus(paths)).choices.find((choice) => choice.id === `stored:${browserVersion}`)?.present,
    ).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("browser recommendations stay platform-scoped and unknown installations never receive catalog labels", async () => {
  const { browserBuildLabels, supportedBrowsers } = await import("../src/browser-assets")
  expect(browserBuildLabels(browserVersion, "darwin-arm64").recommended).toBe(true)
  expect(browserBuildLabels("156.0.1-beta.39", "darwin-arm64")).toEqual({
    latest: true,
    recommended: false,
    deprecated: false,
    nightly: false,
  })
  expect(browserBuildLabels(browserVersion, "linux-arm64")).toEqual({
    latest: true,
    recommended: true,
    deprecated: false,
    nightly: false,
  })
  expect(browserBuildLabels("unknown", "android-arm")).toEqual({
    latest: false,
    recommended: false,
    deprecated: false,
    nightly: false,
  })
  const home = await mkdtemp(join(tmpdir(), "trawl-browser-labels-"))
  try {
    const paths = runtimePaths(home)
    const choices = (await browserStatus(paths)).choices
    expect(choices.filter((choice) => choice.latest)).toHaveLength(
      supportedBrowsers.some((build) => build.assets[`${process.platform}-${process.arch}`]) ? 1 : 0,
    )
    await mkdir(paths.browser)
    await writeFile(join(paths.browser, "trawl-browser.json"), JSON.stringify({ version: "retired" }))
    expect((await browserStatus(paths)).choices.find((choice) => choice.id === "active")).toMatchObject({
      latest: false,
      recommended: false,
      deprecated: false,
      nightly: false,
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("nightly and deprecated metadata are explicit and cannot displace latest or recommended builds", async () => {
  const { browserBuildLabels, supportedBrowsers } = await import("../src/browser-assets")
  const build = supportedBrowsers[0]
  if (!build) throw new Error("Missing default browser fixture")
  const platform = "darwin-arm64"
  const catalog = [
    build,
    { ...build, version: "999.0.0-beta.1" },
    { ...build, version: "999.0.0-nightly.1", channel: "nightly" as const },
    { ...build, version: "999.0.0-beta.2", deprecated: true },
  ]
  expect(browserBuildLabels("999.0.0-beta.1", platform, catalog)).toMatchObject({
    latest: true,
    deprecated: false,
    nightly: false,
  })
  expect(browserBuildLabels("999.0.0-nightly.1", platform, catalog)).toEqual({
    latest: false,
    recommended: false,
    deprecated: false,
    nightly: true,
  })
  expect(browserBuildLabels("999.0.0-beta.2", platform, catalog)).toMatchObject({
    latest: false,
    deprecated: true,
    nightly: false,
  })
  expect(browserBuildLabels(browserVersion, platform, [{ ...build, deprecated: true }])).toMatchObject({
    recommended: false,
    deprecated: true,
  })
  expect(browserBuildLabels(browserVersion, platform, [{ ...build, channel: "nightly" }])).toMatchObject({
    recommended: false,
    nightly: true,
  })
  expect(browserBuildLabels("unknown-nightly-build", platform, catalog)).toMatchObject({
    deprecated: false,
    nightly: false,
  })
})
