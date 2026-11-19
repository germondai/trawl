import { expect, test } from "bun:test"
import { emptyConfig } from "@trawl/config/catalog"
import { createPinia, setActivePinia } from "pinia"
import { useDesktopStore } from "../app/stores/desktop"
import { mergeConfigChanges } from "../app/utils/config-changes"

test("queued config drafts preserve a newer connection order", () => {
  const baseline = emptyConfig(),
    draft = structuredClone(baseline),
    current = structuredClone(baseline)
  draft.desktop.smoothScroll = false
  current.desktop.instanceOrder = ["remote", "local"]
  expect(mergeConfigChanges(baseline, draft, current).desktop).toMatchObject({
    smoothScroll: false,
    instanceOrder: ["remote", "local"],
  })
})

test("reordering never enters server busy state or refreshes its data and serializes saves", async () => {
  const before = Reflect.get(globalThis, "window"),
    nativeBefore = Reflect.get(globalThis, "isTauri")
  const calls: any[] = [],
    writes: { request: any; resolve: (value: any) => void }[] = []
  Reflect.set(globalThis, "isTauri", true)
  Reflect.set(globalThis, "window", {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: any) => {
        calls.push({ command, ...args })
        return new Promise((resolve) => writes.push({ request: args.request, resolve }))
      },
    },
  })
  setActivePinia(createPinia())
  try {
    const desktop = useDesktopStore()
    desktop.config.desktop.connections = [{ id: "remote", name: "Owned fixture", baseURL: "http://localhost:8199" }]
    desktop.status = { running: true, ready: true }
    const status = desktop.status
    const stale = desktop.bootstrap()
    const first = desktop.reorderInstance("local", 1),
      second = desktop.reorderInstance("remote", 1)
    await Promise.resolve()
    expect(writes).toHaveLength(2)
    expect(desktop.busy).toBe(false)
    expect(desktop.status).toBe(status)
    writes[1]!.resolve(writes[1]!.request.config)
    await first
    await Promise.resolve()
    expect(writes[2]!.request.config.desktop.instanceOrder).toEqual(["local", "remote"])
    writes[0]!.resolve({
      config: emptyConfig(),
      inherited: {},
      effective: {},
      sources: {},
      status,
      catalog: [],
      browser: { installed: false },
    })
    await stale
    expect(desktop.config.desktop.connections).toHaveLength(1)
    writes[2]!.resolve(writes[2]!.request.config)
    await second
    expect(desktop.busy).toBe(false)
    expect(desktop.status).toBe(status)
    expect(calls.map((call) => call.request.action)).toEqual(["bootstrap", "saveConfig", "saveConfig"])
  } finally {
    Reflect.set(globalThis, "window", before)
    Reflect.set(globalThis, "isTauri", nativeBefore)
  }
})

test("connection membership changes preserve the relative order saved by an in-flight reorder", () => {
  const baseline = emptyConfig()
  baseline.desktop.connections = ["a", "b"].map((id) => ({ id, name: id, baseURL: "http://localhost:8199" }))
  baseline.desktop.instanceOrder = ["local", "a", "b"]
  const draft = structuredClone(baseline),
    current = structuredClone(baseline)
  draft.desktop.connections.push({ id: "c", name: "c", baseURL: "http://localhost:8198" })
  draft.desktop.instanceOrder = ["local", "a", "b", "c"]
  current.desktop.instanceOrder = ["local", "b", "a"]
  expect(mergeConfigChanges(baseline, draft, current).desktop.instanceOrder).toEqual(["local", "b", "a", "c"])
  draft.desktop.connections = draft.desktop.connections.filter((c) => c.id === "a")
  draft.desktop.instanceOrder = ["local", "a"]
  expect(mergeConfigChanges(baseline, draft, current).desktop.instanceOrder).toEqual(["local", "a"])
})

test("an implicit original order also preserves a newly saved reorder", () => {
  const baseline = emptyConfig()
  baseline.desktop.connections = [{ id: "a", name: "a", baseURL: "http://localhost:8199" }]
  const draft = structuredClone(baseline),
    current = structuredClone(baseline)
  draft.desktop.connections.push({ id: "b", name: "b", baseURL: "http://localhost:8198" })
  draft.desktop.instanceOrder = ["local", "a", "b"]
  current.desktop.instanceOrder = ["a", "local"]
  expect(mergeConfigChanges(baseline, draft, current).desktop.instanceOrder).toEqual(["a", "local", "b"])
})
