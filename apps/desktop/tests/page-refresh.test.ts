import { expect, test } from "bun:test"
import { effectScope, nextTick } from "vue"
import { createPageRefresh } from "../app/composables/usePageRefresh"
import { useRefreshRevision } from "../app/composables/useRefreshRevision"

test("page refresh retains mounted handlers, waits for data and coalesces repeated refreshes", async () => {
  let resolve!: () => void
  const calls: string[] = []
  const refresh = createPageRefresh(async () => {
    calls.push("prepare")
  })
  refresh.register(async () => {
    calls.push("read")
    await new Promise<void>((done) => {
      resolve = done
    })
  })
  const unregister = refresh.register(async () => {
    calls.push("unmounted")
  })
  unregister()
  const pending = refresh.refresh()
  expect(refresh.refresh()).toBe(pending)
  await nextTick()
  expect(refresh.busy.value).toBe(true)
  expect(calls).toEqual(["prepare", "read"])
  resolve()
  await pending
  expect(refresh.busy.value).toBe(false)
})
test("watch refresh completion cannot settle the following revision and disposes pending work", async () => {
  const scope = effectScope()
  const refresh = scope.run(useRefreshRevision)!
  let completed = false
  const first = refresh.refresh()
  const second = refresh.refresh().then(() => {
    completed = true
  })
  refresh.finish(1)
  await first
  expect(completed).toBe(false)
  scope.stop()
  await second
  expect(completed).toBe(true)
})

test("leaving the page during a chained refresh cannot strand the global refresh", async () => {
  const scope = effectScope()
  const revisions = scope.run(() => [useRefreshRevision(), useRefreshRevision()])!
  const page = createPageRefresh(async () => {})
  page.register(async () => {
    await revisions[0]!.refresh()
    await revisions[1]!.refresh()
  })
  const pending = page.refresh()
  await nextTick()
  scope.stop()
  await pending
  expect(page.busy.value).toBe(false)
  expect(revisions[1]!.revision.value).toBe(0)
})
