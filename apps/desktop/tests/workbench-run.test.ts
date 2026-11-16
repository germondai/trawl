import { expect, test } from "bun:test"
import { jsonPreview } from "../app/utils/json-preview"

test("remote JSON previews bound depth, width and rendered characters", () => {
  let deep: unknown = "end"
  for (let index = 0; index < 20000; index++) deep = { nested: deep }
  expect(jsonPreview(deep)).toContain("Preview limited")
  const result = jsonPreview(Array(5000).fill("x".repeat(10000)))
  expect(result.length).toBeLessThanOrEqual(128 * 1024)
})

test("stopped runs keep an unconfirmed ID and malformed failure diagnostics cannot leave a run pending", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import assert from "node:assert/strict"
    import { effectScope, shallowRef, reactive, watch, onScopeDispose, toRaw, nextTick } from "vue"
    import { TrawlError } from "@trawl/client"
    const visible = shallowRef("visible")
    const id = "10000000-0000-4000-8000-000000000000"
    let finish, fail = false
    let deep = "end"
    for(let i=0;i<20000;i++) deep = {nested:deep}
    const desktop = reactive({activeId:"fixture",capabilities:{clientRequestIds:true},client(observe){
      return {scrape:async (_request,options)=>{
        observe(id,true)
        if(fail) throw new TrawlError("failed "+"x".repeat(10000),{kind:"api",status:500,data:{timings:deep},requestId:id})
        return new Promise(resolve=>{finish=resolve})
      }}
    }})
    Object.assign(globalThis,{shallowRef,watch,onScopeDispose,toRaw,useDesktopStore:()=>desktop,useDocumentVisibility:()=>visible})
    const { useWorkbenchRun } = await import("./app/composables/useWorkbenchRun.ts")
    const { newWorkbenchDraft } = await import("./app/utils/workbench.ts")
    const scope = effectScope()
    const run = scope.run(()=>useWorkbenchRun())
    const draft = {...newWorkbenchDraft(),url:"https://owned.fixture"}
    const pending = run.send(draft)
    assert.equal(run.state.value,"pending")
    assert.equal(run.requestId.value,id)
    assert.equal(run.requestIdConfirmed.value,false)
    run.stop()
    assert.equal(run.state.value,"stopped")
    assert.equal(run.requestId.value,id)
    finish({requestId:"canonical-id"})
    await pending
    assert.equal(run.requestId.value,id)
    fail=true
    await run.send(draft)
    assert.equal(run.state.value,"failed")
    assert.equal(run.requestIdConfirmed.value,true)
    assert.ok(run.failureDetails.value.includes("Preview limited"))
    assert.ok(run.error.value.length < 4200)
    desktop.activeId="another"
    await nextTick()
    assert.equal(run.state.value,"idle")
    assert.equal(run.requestId.value,"")
    scope.stop()
  `,
    ],
    cwd: `${import.meta.dir}/..`,
    env: { PATH: process.env.PATH },
    timeout: 10000,
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})
