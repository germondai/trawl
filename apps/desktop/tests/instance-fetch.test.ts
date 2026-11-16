import { expect, test } from "bun:test"

test("native fetch keeps credentials outside the renderer and bounds streaming IPC with acknowledgements", () => {
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
      let completed
      let channel
      let acknowledgement = []
      let cancellations = 0
      let streamArgs
      mockIPC(async (command, args) => {
        if (command === "api_request") {
          assert.deepEqual(args, { instanceId:"saved",path:"/settings" })
          return {status:200,body:'{"readOnly":true}'}
        }
        if (command === "api_stream") {
          streamArgs = args
          channel = args.onEvent
          channel.onmessage({type:"registered"})
          channel.onmessage({type:"open",status:200})
          channel.onmessage({type:"data",sequence:1,frame:"event: ready\\ndata: {}\\n\\n"})
          return new Promise(resolve => {completed=resolve})
        }
        if (command === "api_stream_ack") {
          acknowledgement.push(args.sequence)
          if (args.sequence === 1) queueMicrotask(() => channel.onmessage({type:"data",sequence:2,frame:"event: entry\\ndata: {}\\n\\n"}))
          return
        }
        if (command === "api_stream_cancel") { cancellations++; completed?.(); return }
        throw new Error("Unexpected IPC command")
      })
      const fetch = createInstanceFetch("saved", "https://owned.test/prefix")
      assert.equal((await (await fetch("https://owned.test/prefix/settings")).json()).readOnly,true)
      await assert.rejects(fetch("https://other.test/settings"), /Unsupported/)
      await assert.rejects(fetch("https://owned.test/prefix/settings",{method:"POST"}), /Unsupported/)
      const response = await fetch("https://owned.test/prefix/requests/events")
      assert.equal(response.status,200)
      assert.equal(streamArgs.instanceId,"saved")
      assert.equal(streamArgs.topic,"requests")
      assert.equal(streamArgs.cursor,null)
      assert.ok(!("apiKey" in streamArgs))
      await Bun.sleep(1)
      assert.deepEqual(acknowledgement,[])
      const reader = response.body.getReader()
      assert.match(new TextDecoder().decode((await reader.read()).value),/ready/)
      assert.match(new TextDecoder().decode((await reader.read()).value),/entry/)
      assert.ok(acknowledgement.includes(1))
      await reader.cancel()
      assert.ok(cancellations >= 1)
      clearMocks()
    `,
    ],
    cwd: `${import.meta.dir}/..`,
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})
