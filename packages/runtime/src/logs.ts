import { constants } from "node:fs"
import { lstat, open, rename, rm } from "node:fs/promises"
import { runtimePaths } from "./paths"

// Copy and truncate keeps inherited append-only stdout/stderr descriptors on the live log.
export async function compactLog(path: string, limit = 20 * 1024 * 1024) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (!info) return
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Log must be a regular file")
  if (info.size < limit) return
  const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW || 0))
  try {
    const bytes = Buffer.alloc(limit)
    const read = await file.read(bytes, 0, limit, Math.max(0, info.size - limit))
    await rm(`${path}.3`, { force: true })
    for (const suffix of [2, 1])
      await rename(`${path}.${suffix}`, `${path}.${suffix + 1}`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    const previous = await open(`${path}.1`, "w", 0o600)
    try {
      await previous.writeFile(bytes.subarray(0, read.bytesRead))
    } finally {
      await previous.close()
    }
    await file.truncate(0)
  } finally {
    await file.close()
  }
}
export function maintainLogs(paths = runtimePaths()) {
  let active = false
  const timer = setInterval(async () => {
    if (active) return
    active = true
    try {
      await compactLog(paths.log)
    } catch {
      /* A failed rotation must not crash active requests. */
    } finally {
      active = false
    }
  }, 10000)
  timer.unref()
  return () => clearInterval(timer)
}
