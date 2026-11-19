import { expect, test } from "bun:test"
import { Trawl } from "@trawl/client"
import { jpegPreviewBytes } from "../app/utils/jpeg-preview"
import {
  capturedWorkbenchDraft,
  newWorkbenchDraft,
  replacesWorkbenchDraft,
  sendWorkbench,
  workbenchRequest,
} from "../app/utils/workbench"

test("read replay preserves output limits and proxy headers cannot be silently stripped", async () => {
  let sent: unknown
  const draft = capturedWorkbenchDraft({
    version: 1,
    source: "mcp",
    operation: "read",
    parameters: { url: "https://owned.fixture", format: "text", maxCharacters: 1000 },
  })
  await sendWorkbench(
    {
      read: async (request: unknown) => {
        sent = request
        return {}
      },
    } as unknown as Trawl,
    draft,
    new AbortController().signal,
  )
  expect(sent).toMatchObject({ format: "text", maxCharacters: 1000 })
  for (const name of ["Authorization", "Cookie", "User-Agent"])
    expect(() =>
      capturedWorkbenchDraft({
        version: 1,
        source: "proxy",
        operation: "scrape",
        parameters: { url: "https://owned.fixture", headers: { [name]: "private" } },
      }),
    ).toThrow("cannot replay")
})

test("captured API and Prowlarr inputs reopen faithfully without replacing an unsent draft implicitly", () => {
  const payload = '{ "input": true }'
  const draft = capturedWorkbenchDraft({
    version: 1,
    source: "flaresolverr",
    operation: "scrape",
    parameters: {
      url: "https://owned.fixture/",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      sessionId: "fixture-session",
      proxy: "http://proxy.fixture:8080",
    },
  })
  expect(draft.bodyMode).toBe("text")
  expect(draft.body).toBe(payload)
  expect(workbenchRequest(draft)).toMatchObject({
    method: "POST",
    body: payload,
    proxy: "http://proxy.fixture:8080",
    sessionId: "fixture-session",
  })
  expect(replacesWorkbenchDraft(newWorkbenchDraft(), draft)).toBe(false)
  expect(replacesWorkbenchDraft(draft, { ...draft })).toBe(false)
  expect(replacesWorkbenchDraft({ ...draft, body: "unsent" }, draft)).toBe(true)
  const binary = capturedWorkbenchDraft({
    version: 1,
    operation: "scrape",
    bodyEncoding: "base64",
    parameters: { url: "https://owned.fixture/", method: "POST", body: "AP+A" },
  })
  expect(binary.bodyMode).toBe("binary")
  expect(workbenchRequest(binary)).toMatchObject({ body: "AP+A", bodyEncoding: "base64" })
  const extracted = capturedWorkbenchDraft({
    version: 1,
    source: "native",
    operation: "extract",
    parameters: { url: "https://owned.fixture/", itemSelector: "a", fields: { text: { selector: ":scope" } } },
  })
  expect(extracted.output).toBe("extract")
  expect(JSON.parse(extracted.extraction)).toMatchObject({ itemSelector: "a" })
})

test("screenshot previews reject excessive decoded pixels and active document formats", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 64, 0, 64, 1, 1, 0x11, 0, 0xff, 0xd9])
  expect(jpegPreviewBytes(Buffer.from(jpeg).toString("base64"))).toEqual(jpeg)
  jpeg[7] = 0xff
  jpeg[9] = 0xff
  expect(() => jpegPreviewBytes(Buffer.from(jpeg).toString("base64"))).toThrow("megapixel")
  expect(() => jpegPreviewBytes(btoa('<svg onload="alert(1)"/>'))).toThrow("JPEG")
})

test("workbench GET and JSON POST use the native client without retries or manual JSON headers", async () => {
  const calls: Request[] = []
  const api = new Trawl({
    baseURL: "https://instance.fixture",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return Response.json({
        requestId: "owned-id",
        url: "https://target.fixture/",
        html: "Owned response",
        cookies: [],
        userAgent: "fixture",
        statusCode: 200,
        tier: 1,
        sessionCached: false,
        timings: [],
        totalMs: 2,
      })
    },
  })
  const draft = { ...newWorkbenchDraft(), url: "https://target.fixture", maxTier: 1 as const }
  const signal = new AbortController().signal
  expect((await sendWorkbench(api, draft, signal)).requestId).toBe("owned-id")
  expect(await calls[0]?.json()).toMatchObject({ method: "GET", url: "https://target.fixture/" })
  draft.method = "POST"
  draft.bodyMode = "json"
  draft.body = '{"message":"hello"}'
  await sendWorkbench(api, draft, signal)
  expect(calls).toHaveLength(2)
  expect(await calls[1]?.json()).toMatchObject({
    method: "POST",
    body: '{"message":"hello"}',
    headers: { "Content-Type": "application/json" },
  })
})

test("workbench rejects invalid JSON, hidden core overrides and body-bearing GETs before sending", () => {
  const draft = { ...newWorkbenchDraft(), url: "https://target.fixture" }
  for (const patch of [
    { headers: '{"Authorization":true}' },
    { options: '{"url":"https://other.fixture"}' },
    { options: '{"headers":{}}' },
    { timeout: 181 },
    { sessionId: "../bad" },
    { url: "file:///etc/passwd" },
    { url: "https://secret@target.fixture" },
    { bodyMode: "json" as const, body: "{}" },
    { method: "POST" as const, bodyMode: "json" as const, body: "null" },
  ])
    expect(() => workbenchRequest({ ...draft, ...patch })).toThrow()
  expect(workbenchRequest({ ...draft, method: "POST", bodyMode: "text", body: "hello" }).headers).toEqual({
    "Content-Type": "text/plain; charset=utf-8",
  })
})

test("desktop operations preserve auth separation, response IDs and cancellation registration races", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import assert from "node:assert/strict"
    globalThis.window = { crypto: globalThis.crypto }
    const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks")
    const { createInstanceFetch } = await import("./app/utils/instance-fetch.ts")
    let argsSeen, resolveOperation, channel, cancellations = 0
    let pending = false
    mockIPC(async (command, args) => {
      if (command === "api_operation_cancel") { cancellations++; resolveOperation?.(new ArrayBuffer(0)); return }
      assert.equal(command, "api_operation")
      argsSeen = args
      channel = args.onEvent
      if (pending) return new Promise(resolve => { resolveOperation = resolve })
      channel.onmessage({type:"registered",requestId:args.operationId})
      channel.onmessage({type:"open",status:422,requestId:"owned-id"})
      return new TextEncoder().encode('{"error":"Target failed"}').buffer
    })
    const ids = []
    const fetch = createInstanceFetch("saved", "https://instance.fixture/prefix", (id,proposed)=>ids.push({id,proposed}))
    const response = await fetch("https://instance.fixture/prefix/scrape", {method:"POST", body:'{"url":"https://target.fixture"}'})
    assert.equal(response.status,422)
    assert.equal(response.headers.get("x-trawl-request-id"),"owned-id")
    assert.deepEqual(await response.json(), {error:"Target failed"})
    assert.equal(argsSeen.path,"/scrape")
    assert.equal(argsSeen.instanceId,"saved")
    assert.ok(!("apiKey" in argsSeen))
    assert.equal(ids[0].id,argsSeen.operationId)
    assert.equal(ids[0].proposed,true)
    assert.deepEqual(ids[1],{id:"owned-id",proposed:false})
    await assert.rejects(fetch("https://instance.fixture/prefix/settings", {method:"POST"}), /Unsupported/)
    pending = true
    const abort = new AbortController()
    const waiting = fetch("https://instance.fixture/prefix/read", {method:"POST", body:'{}', signal:abort.signal})
    await Bun.sleep(1)
    abort.abort()
    await assert.rejects(waiting, /Stopped waiting/)
    channel.onmessage({type:"registered"})
    await Bun.sleep(1)
    assert.ok(cancellations >= 2)
    clearMocks()
  `,
    ],
    cwd: `${import.meta.dir}/..`,
    env: { PATH: process.env.PATH },
    timeout: 10000,
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})

test("instance drafts survive navigation within the four-instance bound without persisting target secrets", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import assert from "node:assert/strict"
    import { createPinia, defineStore, setActivePinia } from "pinia"
    import { reactive, ref, watch, toRaw } from "vue"
    const desktop = reactive({activeId:"a"})
    Object.assign(globalThis, {defineStore,ref,watch,toRaw,useDesktopStore:()=>desktop})
    const { useWorkbenchStore } = await import("./app/stores/workbench.ts")
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    for (const id of ["a","b","c","d"]) {
      desktop.activeId = id
      store.draft.url = "https://" + id + ".fixture"
      store.draft.headers = '{"Authorization":"private-target"}'
      store.draft.fields.body = [{enabled:true,key:"upload",value:"",description:"",file:{name:"owned.bin",type:"application/octet-stream",data:"AP+A"}}]
      store.draft.fields.body = store.draft.fields.body.filter(row=>row.enabled)
    }
    desktop.activeId = "a"
    assert.equal(store.draft.url,"https://a.fixture")
    assert.equal(store.draft.fields.body[0].file.data,"AP+A")
    const firstTab=store.activeTabId
    assert.equal(store.addTab(),true)
    store.draft.url="https://second.fixture"
    store.activeTabId=firstTab
    assert.equal(store.draft.url,"https://a.fixture")
    while(store.tabs.length<8)assert.equal(store.addTab(),true)
    assert.equal(store.addTab(),false)
    const activeTab=store.activeTabId
    store.closeTab(activeTab)
    assert.equal(store.tabs.length,7)
    assert.notEqual(store.activeTabId,activeTab)
    desktop.activeId = "e"
    assert.equal(store.draft.url,"")
    desktop.activeId = "b"
    assert.equal(store.draft.url,"")
    assert.equal(store.draft.headers,"{}")
  `,
    ],
    cwd: `${import.meta.dir}/..`,
    env: { PATH: process.env.PATH },
    timeout: 10000,
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})
