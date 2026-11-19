import { expect, mock, test } from "bun:test"
import { emptyConfig } from "@trawl/config/catalog"
import { createPinia, setActivePinia } from "pinia"

let capabilityFailures = 0
let capabilityReads = 0
let localStatus = { running: false, ready: false }
let healthReads = 0
const capabilities = {
  version: 1,
  authentication: "bearer",
  settings: true,
  requests: true,
  requestEvents: true,
  logs: true,
  logEvents: true,
  captures: false,
  browserInspection: false,
}
let release: ((value: { status: number; body: string }) => void) | undefined
const health = { status: "ok", uptime: 1, pool: {} }
const metrics = {
  startedAt: null,
  rangeMinutes: 60,
  retainedEvents: 0,
  requests: 2,
  successes: 2,
  failures: 0,
  averageMs: 1,
  bySource: {},
  byTier: {},
  bucketMs: 60000,
  timeline: [],
  domains: [],
  recentEvents: [],
}
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  Channel: class {},
  invoke: async (command: string, request: { instanceId: string; path: string }) => {
    if (command === "instance_status") return localStatus
    if (command === "server_start") throw "Local server stopped during startup. Check Logs for details."
    if (command === "management") throw new Error("Fixture configuration is unavailable")
    if (request.path === "/health" && request.instanceId === "local") {
      healthReads++
      return { status: 503, body: '{"status":"starting","pool":{}}' }
    }
    if (request.path === "/capabilities" && request.instanceId === "transient") {
      capabilityReads++
      if (capabilityFailures-- > 0) return { status: 503, body: '{"error":"Temporarily unavailable"}' }
      return { status: 200, body: JSON.stringify(capabilities) }
    }
    if (request.instanceId === "slow")
      return new Promise((resolve) => {
        release = resolve
      })
    return { status: 200, body: JSON.stringify(request.path === "/health" ? health : metrics) }
  },
}))
const { useDesktopStore } = await import("../app/stores/desktop")
test("a local instance warming up does not display a transient HTTP 503 alert", async () => {
  setActivePinia(createPinia())
  const store = useDesktopStore()
  localStatus = { running: true, ready: false }
  healthReads = 0
  await store.refresh()
  expect(store.error).toBe("")
  expect(healthReads).toBe(0)
  expect(store.health).toBeUndefined()
  localStatus = { running: false, ready: false }
})
test("a slow previous connection cannot overwrite the selected dashboard", async () => {
  setActivePinia(createPinia())
  const store = useDesktopStore()
  const config = emptyConfig()
  config.desktop.connections = [
    { id: "slow", name: "Slow", baseURL: "https://slow.example" },
    { id: "fast", name: "Fast", baseURL: "https://fast.example" },
  ]
  store.config = config
  const slow = store.select("slow")
  await Bun.sleep(0)
  expect(release).toBeDefined()
  await store.select("fast")
  expect(store.metrics?.requests).toBe(2)
  release?.({ status: 200, body: JSON.stringify({ ...health, uptime: 999 }) })
  await slow
  expect(store.activeId).toBe("fast")
  expect(store.health?.uptime).toBe(1)
  expect(store.metrics?.requests).toBe(2)
})

test("a failed startup bootstrap never marks placeholder configuration as loaded", async () => {
  setActivePinia(createPinia())
  const store = useDesktopStore()
  expect(store.loaded).toBe(false)
  expect(await store.action(() => store.bootstrap())).toBe(false)
  expect(store.loaded).toBe(false)
})

test("native startup errors retain their actionable message", async () => {
  setActivePinia(createPinia())
  const store = useDesktopStore()
  expect(await store.start()).toBe(false)
  expect(store.error).toBe("Local server stopped during startup. Check Logs for details.")
})

test("capability discovery retries a transient failure on the selected instance", async () => {
  setActivePinia(createPinia())
  const store = useDesktopStore()
  const config = emptyConfig()
  config.desktop.connections = [{ id: "transient", name: "Transient", baseURL: "https://owned.example" }]
  store.config = config
  capabilityFailures = 1
  capabilityReads = 0
  await store.select("transient")
  expect(store.capabilities).toBeUndefined()
  await store.refresh()
  expect(store.capabilities?.settings).toBe(true)
  expect(capabilityReads).toBe(2)
})
