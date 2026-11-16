import { expect, test } from "bun:test"
import { type StreamEvent, Trawl } from "@trawl/client"
import { effectScope, nextTick, reactive, shallowRef, watch } from "vue"
import { useInstanceFeed } from "../app/composables/useInstanceFeed"

test("an old instance snapshot cannot commit after switching and visibility changes release subscriptions", async () => {
  const visible = shallowRef("visible")
  const api = new Trawl({ baseURL: "https://owned.fixture" })
  const store = reactive({ activeId: "first", native: true, client: () => api })
  const helpers = { shallowRef, watch, useDesktopStore: () => store, useDocumentVisibility: () => visible }
  const descriptors = Object.fromEntries(
    Object.keys(helpers).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  )
  Object.assign(globalThis, helpers)
  const scope = effectScope()
  let release: (value: { cursor: string; source: string }) => void = () => {}
  const old = new Promise<{ cursor: string; source: string }>((resolve) => {
    release = resolve
  })
  const cursor = "10000000-0000-4000-8000-000000000000:0"
  const committed: string[] = []
  let subscribers = 0
  try {
    const feed = scope.run(() =>
      useInstanceFeed<string, { cursor: string; source: string }>({
        enabled: () => true,
        snapshot: () => (store.activeId === "first" ? old : Promise.resolve({ cursor, source: "second" })),
        replace: ({ source }) => {
          committed.push(source)
        },
        events: async function* (_api, options): AsyncGenerator<StreamEvent<string>> {
          subscribers++
          try {
            yield { type: "ready", id: cursor }
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener("abort", () => resolve(), { once: true })
              if (options.signal?.aborted) resolve()
            })
          } finally {
            subscribers--
          }
        },
        apply: () => {},
        clear: () => {},
      }),
    )
    store.activeId = "second"
    await nextTick()
    await Bun.sleep(1)
    expect(committed).toEqual(["second"])
    release({ cursor, source: "first" })
    await Bun.sleep(1)
    expect(committed).toEqual(["second"])
    expect(subscribers).toBe(1)
    visible.value = "hidden"
    await nextTick()
    await Bun.sleep(1)
    expect(subscribers).toBe(0)
    expect(feed?.state.value).toBe("paused")
    visible.value = "visible"
    await nextTick()
    await Bun.sleep(1)
    expect(subscribers).toBe(1)
    scope.stop()
    await Bun.sleep(1)
    expect(subscribers).toBe(0)
  } finally {
    scope.stop()
    release({ cursor, source: "first" })
    for (const name of Object.keys(helpers)) {
      const descriptor = descriptors[name]
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
