import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "../src/cli"

function capture() {
  let stdout = "",
    stderr = ""
  return {
    io: {
      out: (v: string) => {
        stdout += v
      },
      err: (v: string) => {
        stderr += v
      },
      input: async () => "{}",
    },
    result: () => ({ stdout, stderr }),
  }
}
test("help does not start a server or require a local browser", async () => {
  const c = capture()
  expect(await runCli(["--help"], c.io)).toBe(0)
  expect(c.result().stdout).toContain("Usage: trawl")
  expect(c.result().stderr).toBe("")
})
test("validates and saves configuration without exposing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "trawl-cli-"))
  try {
    const c = capture()
    expect(await runCli(["config", "set", "STT_API_KEY", "test-private-value", "--home", root], c.io)).toBe(0)
    expect(c.result().stdout).not.toContain("test-private-value")
    const bad = capture()
    expect(await runCli(["config", "set", "PORT", "0", "--home", root], bad.io)).toBe(2)
    expect(bad.result().stderr).toContain("PORT")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("API commands share SDK transport and return structured output", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-cli-api-"))
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      expect(new URL(request.url).pathname).toBe("/scrape")
      const body = await request.json()
      return Response.json({
        url: body.url,
        html: "owned",
        cookies: [],
        statusCode: 200,
        userAgent: "fixture",
        tier: 1,
        timings: [],
        totalMs: 1,
        sessionCached: false,
      })
    },
  })
  try {
    const c = capture()
    expect(
      await runCli(
        ["scrape", "https://target.example", "--base-url", `http://127.0.0.1:${server.port}`, "--home", home],
        c.io,
      ),
    ).toBe(0)
    expect(JSON.parse(c.result().stdout).html).toBe("owned")
  } finally {
    await server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
})

test("session eval preserves the server budget in request JSON", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-cli-api-"))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      expect(new URL(request.url).pathname).toBe("/sessions/owned/eval")
      expect(await request.json()).toEqual({ expression: "2+2", maxTimeout: 1000 })
      return Response.json({ value: 4 })
    },
  })
  try {
    const captureResult = capture()
    expect(
      await runCli(
        [
          "sessions",
          "eval",
          "owned",
          "--options",
          "-",
          "--base-url",
          `http://127.0.0.1:${server.port}`,
          "--home",
          home,
        ],
        {
          ...captureResult.io,
          input: async () => JSON.stringify({ expression: "2+2", maxTimeout: 1000 }),
        },
      ),
    ).toBe(0)
    expect(captureResult.result().stdout.trim()).toBe("4")
  } finally {
    await server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
})

test("session deletion returns valid JSON", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-cli-api-"))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      expect(request.method).toBe("DELETE")
      return Response.json({ status: "ok" })
    },
  })
  try {
    const c = capture()
    expect(
      await runCli(
        ["sessions", "destroy", "owned", "--base-url", `http://127.0.0.1:${server.port}`, "--home", home],
        c.io,
      ),
    ).toBe(0)
    expect(JSON.parse(c.result().stdout)).toEqual({ status: "ok" })
  } finally {
    await server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
})

test("cancelled API commands return the conventional interrupt code", async () => {
  const home = await mkdtemp(join(tmpdir(), "trawl-cli-cancel-"))
  const c = capture()
  try {
    expect(await runCli(["health", "--home", home], { ...c.io, signal: AbortSignal.abort() })).toBe(130)
    expect(c.result().stderr).toBe("Command cancelled\n")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
