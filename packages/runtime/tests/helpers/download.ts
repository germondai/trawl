import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadVerified } from "../../src/assets"

const directory = await mkdtemp(join(tmpdir(), "trawl-download-"))
const destination = join(directory, "asset")
const body = Buffer.from("owned asset")
const asset = {
  url: "https://owned.invalid/asset",
  size: body.length,
  sha256: createHash("sha256").update(body).digest("hex"),
}
try {
  globalThis.fetch = Object.assign(async () => new Response(body), { preconnect: () => {} })
  await downloadVerified(asset, destination)
  assert.deepEqual(await readFile(destination), body)
  await writeFile(destination, "previous installation")
  await assert.rejects(downloadVerified({ ...asset, sha256: "0".repeat(64) }, destination), /verification/)
  await assert.rejects(downloadVerified({ ...asset, size: body.length - 1 }, destination), /size/)
  const controller = new AbortController()
  const interrupted = async (_input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(body.subarray(0, 2))
          options?.signal?.addEventListener("abort", () => stream.error(new Error("Interrupted download")), {
            once: true,
          })
          setTimeout(() => controller.abort(), 5)
        },
      }),
    )
  globalThis.fetch = Object.assign(interrupted, { preconnect: () => {} })
  await assert.rejects(downloadVerified(asset, destination, controller.signal), /Interrupted|abort/i)
  assert.equal(await readFile(destination, "utf8"), "previous installation")
  assert.deepEqual(await readdir(directory), ["asset"])
  console.log("Verified size, hash, interruption cleanup and preservation of previous assets")
} finally {
  await rm(directory, { recursive: true, force: true })
}
