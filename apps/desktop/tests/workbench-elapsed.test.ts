import { expect, test } from "bun:test"
import { effectScope, onScopeDispose, shallowRef, watch } from "vue"
import { useWorkbenchRun } from "../app/composables/useWorkbenchRun"
import { newWorkbenchDraft } from "../app/utils/workbench"

test("elapsed time advances while a request is pending and freezes on cancellation", async () => {
  let release: (value: unknown) => void = () => {}
  const response = new Promise((resolve) => {
    release = resolve
  })
  const visible = shallowRef("visible")
  const helpers = {
    shallowRef,
    watch,
    onScopeDispose,
    useDesktopStore: () => ({
      native: true,
      activeId: "fixture",
      capabilities: null,
      client: () => ({ scrape: () => response }),
    }),
    useDocumentVisibility: () => visible,
  }
  const descriptors = Object.fromEntries(
    Object.keys(helpers).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  )
  Object.assign(globalThis, helpers)
  const scope = effectScope()
  try {
    const run = scope.run(useWorkbenchRun)
    if (!run) throw new Error("Missing request scope")
    const draft = newWorkbenchDraft()
    draft.url = "https://owned.fixture/"
    const pending = run.send(draft)
    await Bun.sleep(160)
    expect(run.state.value).toBe("pending")
    expect(run.elapsed.value).toBeGreaterThan(0)
    run.stop()
    const stopped = run.elapsed.value
    release({ html: "fixture" })
    await pending
    await Bun.sleep(160)
    expect(run.state.value).toBe("stopped")
    expect(run.elapsed.value).toBe(stopped)
    run.reset()
    expect(run.elapsed.value).toBe(0)
  } finally {
    release({ html: "fixture" })
    scope.stop()
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
