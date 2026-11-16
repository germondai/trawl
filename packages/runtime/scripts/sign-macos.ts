import { randomUUID } from "node:crypto"
import { cp, open, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { digestFile, diskPreflight, replaceDirectory, verifyRuntime } from "../src/assets"

const { values } = parseArgs({
  options: { runtime: { type: "string" }, identity: { type: "string" }, "dry-run": { type: "boolean" } },
})
if (process.platform !== "darwin") throw new Error("macOS signing must run on macOS")
const directory = resolve(values.runtime || ".artifacts/v2/runtime")
const identity = values.identity || ""
if (!values["dry-run"] && !identity) throw new Error("An explicit Developer ID signing identity is required")
const manifest = await verifyRuntime(directory)
const staged = `${directory}.sign-${randomUUID()}`
try {
  if (!values["dry-run"]) {
    await diskPreflight(directory, 20 * 1024 ** 3)
    await cp(directory, staged, { recursive: true })
  }
  for (const name of Object.keys(manifest.files)) {
    const path = join(values["dry-run"] ? directory : staged, name)
    const file = await open(path, "r"),
      magic = Buffer.alloc(4)
    try {
      await file.read(magic, 0, 4, 0)
    } finally {
      await file.close()
    }
    if (!["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "cafebabf"].includes(magic.toString("hex")))
      continue
    if (values["dry-run"]) {
      console.log(`Would sign ${name}`)
      continue
    }
    const command = ["codesign", "--force", "--timestamp", "--options", "runtime", "--sign", identity]
    if (name === "trawl-engine")
      command.push("--entitlements", join(import.meta.dir, "../macos-engine.entitlements.plist"))
    command.push(path)
    const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" })
    if ((await child.exited) !== 0) throw new Error(`Signing failed: ${name}`)
  }
  if (!values["dry-run"]) {
    for (const name of Object.keys(manifest.files)) manifest.files[name] = await digestFile(join(staged, name))
    await writeFile(join(staged, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    await verifyRuntime(staged)
    await replaceDirectory(staged, directory)
  }
} finally {
  await rm(staged, { recursive: true, force: true })
}
