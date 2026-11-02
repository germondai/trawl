import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const retained = process.env.TRAWL_CLIENT_ARTIFACTS
const directory = retained ?? mkdtempSync(join(tmpdir(), "trawl-client-package-"))
mkdirSync(directory, { recursive: true })

async function run(command: string[], cwd = root): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${command[0]} failed (${code}): ${stdout}\n${stderr}`)
  return stdout.trim()
}

try {
  const packages = JSON.parse(
    await run(["npm", "pack", "./packages/client", "--ignore-scripts", "--json", "--pack-destination", directory]),
  )
  const archive = join(directory, packages[0].filename)
  await run([
    "npm",
    "install",
    "--prefix",
    directory,
    "--ignore-scripts",
    "--package-lock=false",
    "--no-audit",
    "--no-fund",
    archive,
  ])
  const smoke = join(directory, "runtime-smoke.mjs")
  const source = readFileSync(join(root, "packages/client/tests/runtime-smoke.mjs"), "utf8")
  writeFileSync(smoke, source)
  const consumer =
    'import { Trawl, type Fetch, type ScrapeRequest, type ReadRequest, type ExtractRequest } from "@trawl/client"; interface Search { query: string }; const body: Search = { query: "owned" }; const options: ScrapeRequest = { url: "https://target.example", method: "POST", body }; const read: ReadRequest = { ...options, format: "text" }; const extract: ExtractRequest = { ...options, fields: { title: { selector: "h1" } } }; const fetch: Fetch = globalThis.fetch; new Trawl({ fetch, headers: { "x-owned": "yes" } });'
  for (const extension of ["mts", "cts"]) writeFileSync(join(directory, `consumer.${extension}`), consumer)
  const config = join(directory, "tsconfig.json")
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        lib: ["ES2022"],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
        typeRoots: [join(root, "packages/client/node_modules/@types")],
      },
      files: ["consumer.mts", "consumer.cts"],
    }),
  )
  await run(["bun", join(root, "packages/client/node_modules/typescript/bin/tsc"), "--project", config])
  console.log("Node TypeScript without DOM: passed")
  for (const runtime of ["node", "bun", "deno"]) {
    if (!Bun.which(runtime)) throw new Error(`${runtime} must be installed to check the package`)
    const args = runtime === "deno" ? ["run", "--no-config", "--node-modules-dir=manual", "--no-lock"] : []
    console.log(`${runtime}: ${await run([runtime, ...args, smoke], directory)}`)
  }
  const commonJS = join(directory, "runtime-smoke.cjs")
  writeFileSync(
    commonJS,
    source.replace(
      'import { Trawl, TrawlError } from "@trawl/client"',
      'const { Trawl, TrawlError } = require("@trawl/client")',
    ),
  )
  console.log(`CommonJS: ${await run(["node", commonJS], directory)}`)
  const bundle = await Bun.build({ entrypoints: [smoke], target: "browser", format: "iife" })
  if (!bundle.success) throw new Error(`Browser bundle failed: ${bundle.logs.join("\n")}`)
  await Bun.write(join(directory, "browser-smoke.js"), bundle.outputs[0])
  console.log(
    JSON.stringify({
      packedBytes: packages[0].size,
      unpackedBytes: packages[0].unpackedSize,
      browserBytes: bundle.outputs[0]?.size,
      archive,
    }),
  )
} finally {
  if (!retained) rmSync(directory, { recursive: true, force: true })
}
