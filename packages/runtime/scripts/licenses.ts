import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

export async function collectLicenses(root: string, destination: string) {
  const visited = new Set<string>()
  const records: { name: string; version: string; license: unknown; files: string[] }[] = []
  async function walk(directory: string) {
    if (visited.has(directory)) return
    visited.add(directory)
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
    const name = String(manifest.name),
      version = String(manifest.version)
    const workspace = directory.startsWith(root) && !directory.includes("node_modules")
    const files: string[] = []
    if (!workspace) {
      const target = join(destination, "npm", `${name.replaceAll("/", "_")}@${version}`)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^(LICENSE|LICENCE|COPYING|NOTICE)([.\s_-]|$)/i.test(entry.name)) continue
        await mkdir(target, { recursive: true })
        await cp(join(directory, entry.name), join(target, entry.name))
        files.push(entry.name)
      }
    }
    records.push({ name, version, license: manifest.license || (workspace ? "AGPL-3.0-only" : "unspecified"), files })
    const require = createRequire(join(directory, "package.json"))
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }
    for (const dependency of Object.keys(dependencies || {})) {
      let source: string | undefined
      try {
        source = dirname(require.resolve(`${dependency}/package.json`))
      } catch {
        try {
          let cursor = dirname(require.resolve(dependency))
          while (cursor !== dirname(cursor)) {
            const candidate = await readFile(join(cursor, "package.json"), "utf8")
              .then(JSON.parse)
              .catch(() => undefined)
            if (candidate?.name === dependency) {
              source = cursor
              break
            }
            cursor = dirname(cursor)
          }
        } catch {
          /* Platform-optional packages may not be installed on this host. */
        }
      }
      if (source) await walk(source)
    }
  }
  for (const directory of ["apps/api", "packages/browser", "packages/tiers", "packages/runtime"])
    await walk(join(root, directory))
  records.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
  await writeFile(join(destination, "npm-dependencies.json"), `${JSON.stringify(records, null, 2)}\n`)
}
