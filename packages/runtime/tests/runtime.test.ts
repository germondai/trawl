import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { control, instanceState, startControl } from "../src/control"
import { runtimePaths } from "../src/paths"
import { emptyConfig, publicConfig, readConfig, writeConfig } from "../src/store"

describe("managed runtime", () => {
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
