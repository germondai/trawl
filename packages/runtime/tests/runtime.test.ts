import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { browserExecutable, browserRoot } from "../src/browser"
import { browserVersion } from "../src/browser-assets"
import { control, instanceState, startControl } from "../src/control"
import { startManaged, stopManaged } from "../src/manager"
import { runtimePaths } from "../src/paths"
import { emptyConfig, publicConfig, readConfig, validateConfig, writeConfig } from "../src/store"

describe("managed runtime", () => {
  test("desktop quit and visibility preferences migrate, validate and persist", async () => {
    const config = emptyConfig()
    const { quitBehavior, appVisibility, ...legacy } = config.desktop
    expect(validateConfig({ ...config, desktop: legacy }).desktop).toMatchObject({ quitBehavior, appVisibility })
    const root = await mkdtemp(join(tmpdir(), "trawl-preferences-"))
    const paths = runtimePaths(root)
    try {
      for (const quit of ["immediate", "double-press", "hold"] as const) {
        for (const visibility of ["dock-and-tray", "dock", "tray"] as const) {
          config.desktop.quitBehavior = quit
          config.desktop.appVisibility = visibility
          await writeConfig(config, paths)
          expect((await readConfig(paths)).desktop).toEqual(config.desktop)
        }
      }
      expect(() => validateConfig({ ...config, desktop: { ...config.desktop, quitBehavior: "unknown" } })).toThrow(
        "preferences",
      )
      expect(() => validateConfig({ ...config, desktop: { ...config.desktop, appVisibility: "hidden" } })).toThrow(
        "preferences",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("the server entry point waits for browser readiness after API import", async () => {
    const home = await mkdtemp(join(tmpdir(), "trawl-api-ready-"))
    const paths = runtimePaths(home)
    const resources = join(home, "fixture-runtime")
    await mkdir(resources, { recursive: true })
    for (const file of [
      browserExecutable(paths.browser),
      join(paths.browser, "GeoLite2-City.mmdb"),
      join(paths.browser, "version.json"),
      join(browserRoot(paths.browser), "addons/UBO/manifest.json"),
    ]) {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, "owned fixture")
    }
    await writeFile(
      join(paths.browser, "trawl-browser.json"),
      JSON.stringify({
        version: browserVersion,
        platform: process.platform,
        arch: process.arch,
        securityBackport: true,
      }),
    )
    const loaded = join(home, "loaded"),
      release = join(home, "release")
    await writeFile(
      join(resources, "api.mjs"),
      `import {writeFileSync,existsSync} from "node:fs"; writeFileSync(${JSON.stringify(loaded)},"loaded"); export const ready=new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);resolve()}},10)});`,
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/server.ts"),
        "serve",
        "--watch-parent",
        "--home",
        home,
      ],
      {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
        env: { PATH: process.env.PATH, TRAWL_RUNTIME_RESOURCES: resources },
        signal: AbortSignal.timeout(10000),
      },
    )
    try {
      const deadline = Date.now() + 5000
      while (!(await Bun.file(loaded).exists()) && Date.now() < deadline) await Bun.sleep(10)
      expect(await Bun.file(loaded).exists()).toBe(true)
      expect(await control("status", paths)).toMatchObject({ running: true, ready: false })
      await writeFile(release, "ready")
      let status = await control("status", paths)
      while (status?.ready !== true && Date.now() < deadline) {
        await Bun.sleep(10)
        status = await control("status", paths)
      }
      expect(status).toMatchObject({ running: true, ready: true })
    } finally {
      child.stdin.end()
      const exited = await Promise.race([child.exited, Bun.sleep(2000).then(() => null)])
      if (exited === null) child.kill()
      await child.exited
      await rm(home, { recursive: true, force: true })
    }
  })
  test("starting waits for API readiness and rejects a failed startup", async () => {
    for (const outcome of ["ready", "failed"]) {
      const root = await mkdtemp(join(tmpdir(), "trawl-ready-"))
      const paths = runtimePaths(root)
      let ready = false
      const close = await startControl(
        paths,
        { owner: "desktop", baseURL: "http://127.0.0.1:8191" },
        () => {},
        () => ready,
      )
      let settled = false
      let closed = false
      const starting = startManaged(paths).finally(() => {
        settled = true
      })
      // Observe a rejected attempt immediately while retaining its eventual assertion.
      void starting.catch(() => {})
      try {
        await Bun.sleep(30)
        expect(settled).toBe(false)
        expect(await control("status", paths)).toMatchObject({ running: true, ready: false })
        if (outcome === "ready") {
          ready = true
          expect(await starting).toMatchObject({ running: true, ready: true, owner: "desktop" })
        } else {
          await close()
          closed = true
          await expect(starting).rejects.toThrow("startup")
        }
      } finally {
        ready = true
        if (!closed) await close()
        await starting.catch(() => {})
        await rm(root, { recursive: true, force: true })
      }
    }
  })
  test("persists validated private configuration and masks connection secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "trawl-runtime-"))
    const paths = runtimePaths(root)
    try {
      const config = emptyConfig()
      config.env.STT_API_KEY = "private"
      config.desktop.connections.push({
        id: "remote",
        name: "Remote",
        baseURL: "https://example.com",
        apiKey: "secret",
      })
      await writeConfig(config, paths)
      expect(await readConfig(paths)).toEqual(config)
      if (process.platform !== "win32") expect((await stat(paths.config)).mode & 0o077).toBe(0)
      expect(JSON.stringify(publicConfig(config))).not.toContain("private")
      expect(JSON.stringify(publicConfig(config))).not.toContain('"secret"')
      await expect(writeConfig({ ...config, env: { PORT: "0" } }, paths)).rejects.toThrow()
      expect(await readConfig(paths)).toEqual(config)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("private control reports ownership, rejects duplicate launch and stops the correct server", async () => {
    const root = await mkdtemp(join(tmpdir(), "trawl-ctl-"))
    const paths = runtimePaths(root)
    let stops = 0
    const close = await startControl(
      paths,
      {
        owner: "desktop",
        baseURL: "http://127.0.0.1:8191",
        dashboardToken: "private-dashboard-token",
        shutdownDrainMs: 70000,
      },
      () => stops++,
    )
    try {
      const status = await control("status", paths)
      expect(status).toMatchObject({ running: true, owner: "desktop", pid: process.pid })
      expect(status).not.toHaveProperty("token")
      expect(status).not.toHaveProperty("dashboardToken")
      expect(status?.shutdownDrainMs).toBe(70000)
      expect((await instanceState(paths))?.dashboardToken).toBe("private-dashboard-token")
      await expect(startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})).rejects.toThrow(
        "already running",
      )
      await control("stop", paths)
      await Bun.sleep(10)
      expect(stops).toBe(1)
    } finally {
      await close()
      await rm(root, { recursive: true, force: true })
    }
  })
  test("stop waits through a control probe closing during acknowledged shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "trawl-stop-exit-"))
    const paths = runtimePaths(root)
    const token = crypto.randomUUID().replaceAll("-", "").repeat(2)
    const socket =
      process.platform === "win32" ? `\\\\.\\pipe\\trawl-${token.slice(0, 24)}` : join(paths.run, "control.sock")
    const status = { running: true, pid: process.pid, owner: "desktop", baseURL: "http://127.0.0.1:8196" }
    let stopping = false
    const server = createServer((client) => {
      client.once("data", async (data) => {
        const request = JSON.parse(data.toString())
        if (request.action === "status" && stopping) {
          client.end()
          await rm(paths.state)
          server.close()
        } else {
          stopping ||= request.action === "stop"
          client.end(`${JSON.stringify(status)}\n`)
        }
      })
    })
    try {
      await writeConfig(emptyConfig(), paths)
      await mkdir(paths.run, { recursive: true })
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(socket, resolve)
      })
      await writeFile(paths.state, JSON.stringify({ ...status, token, socket }))
      expect(await stopManaged(paths)).toEqual({ running: false })
    } finally {
      server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  test("does not connect to an arbitrary socket from a tampered state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "trawl-ctl-"))
    const paths = runtimePaths(root)
    try {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(paths.run)
      await writeFile(
        paths.state,
        JSON.stringify({
          pid: 123,
          token: "a".repeat(64),
          owner: "cli",
          baseURL: "http://localhost",
          socket: "/tmp/other.sock",
        }),
      )
      await expect(instanceState(paths)).rejects.toThrow("Invalid control socket")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test("concurrent starts acquire a single control owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "trawl-lock-")),
    paths = runtimePaths(root)
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => startControl(paths, { owner: "cli", baseURL: "http://127.0.0.1:8191" }, () => {})),
  )
  try {
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  } finally {
    for (const result of results) if (result.status === "fulfilled") await result.value()
    await rm(root, { recursive: true, force: true })
  }
})

test("management inputs stop at their byte budget", async () => {
  const { readText } = await import("../src/input")
  async function* source() {
    yield "1234"
    yield "5678"
    throw new Error("must not read past the limit")
  }
  await expect(readText(source(), 6)).rejects.toThrow("exceeds")
})
test("service definitions quote user paths without shell interpolation", async () => {
  const { serviceDefinition } = await import("../src/services")
  const paths = runtimePaths(join(tmpdir(), "trawl user $value%"))
  const linux = serviceDefinition("/opt/trawl user/server", paths, "linux")
  expect(linux.content).toContain('ExecStart="/opt/trawl user/server" "serve"')
  expect(linux.content).toContain("$$value%%")
  const mac = serviceDefinition("/opt/trawl&user/server", paths, "darwin")
  expect(mac.content).toContain("trawl&amp;user")
  expect(mac.content).toContain("<key>KeepAlive</key><false/>")
})

test("recovers an expired control lease even when the old PID has been reused", async () => {
  const { mkdir, utimes } = await import("node:fs/promises")
  const root = await mkdtemp(join(tmpdir(), "trawl-stale-")),
    paths = runtimePaths(root)
  let close: (() => Promise<void>) | undefined
  try {
    await mkdir(paths.run)
    await writeFile(
      paths.state,
      JSON.stringify({
        pid: process.pid,
        token: "a".repeat(64),
        owner: "cli",
        baseURL: "http://127.0.0.1:8191",
        socket: process.platform === "win32" ? `\\\\.\\pipe\\trawl-${"a".repeat(24)}` : join(paths.run, "control.sock"),
      }),
    )
    const lock = join(paths.run, "instance.lock")
    await mkdir(lock)
    const expired = new Date(Date.now() - 15000)
    await utimes(lock, expired, expired)
    close = await startControl(paths, { owner: "foreground", baseURL: "http://127.0.0.1:8192" }, () => {})
    expect(await control("status", paths)).toMatchObject({
      running: true,
      owner: "foreground",
      baseURL: "http://127.0.0.1:8192",
    })
  } finally {
    await close?.()
    await rm(root, { recursive: true, force: true })
  }
})

test("native settings retain loopback and private storage defaults even with an empty imported config", async () => {
  const { resolveManagedEnvironment } = await import("../src/environment")
  const paths = runtimePaths(join(tmpdir(), "trawl-native-defaults"))
  const resolved = resolveManagedEnvironment(paths, {}, {})
  expect(resolved.values).toMatchObject({
    HOST: "127.0.0.1",
    MITM_HOST: "127.0.0.1",
    SESSION_CACHE_DRIVER: "memory",
    METRICS_DB_PATH: paths.metrics,
    MITM_CA_DIR: paths.ca,
  })
  expect(resolved.sources.HOST).toBe("default")
  expect(resolveManagedEnvironment(paths, { HOST: "0.0.0.0" }, {}).values.HOST).toBe("0.0.0.0")
  expect(resolveManagedEnvironment(paths, { PORT: "8192" }, { PORT: "8193" }, { PORT: "8194" }).values.PORT).toBe(
    "8194",
  )
})

test("instance labels and ordering migrate, validate and survive persistence", async () => {
  const config = emptyConfig()
  const { localName: _name, instanceOrder: _order, ...legacy } = config.desktop
  expect(validateConfig({ ...config, desktop: legacy }).desktop).toMatchObject({
    localName: "Local instance",
    instanceOrder: [],
  })
  config.desktop.localName = "My Mac"
  config.desktop.instanceOrder = ["remote", "local"]
  config.desktop.connections = [{ id: "remote", name: "Home", baseURL: "https://example.com" }]
  const root = await mkdtemp(join(tmpdir(), "trawl-order-"))
  try {
    const paths = runtimePaths(root)
    await writeConfig(config, paths)
    expect((await readConfig(paths)).desktop).toEqual(config.desktop)
    for (const patch of [
      { localName: " " },
      { localName: "x".repeat(101) },
      { instanceOrder: ["local", "local"] },
      { instanceOrder: [null] },
    ]) {
      expect(() => validateConfig({ ...config, desktop: { ...config.desktop, ...patch } })).toThrow()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
