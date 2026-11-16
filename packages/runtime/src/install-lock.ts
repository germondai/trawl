import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
export async function installExclusive<T>(destination: string, action: (check: () => void) => Promise<T>): Promise<T> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const { default: lockfile } = await import("proper-lockfile")
  let compromised: Error | undefined
  let release: () => Promise<void>
  try {
    release = await lockfile.lock(destination, {
      realpath: false,
      stale: 600000,
      update: 10000,
      retries: 0,
      onCompromised: (error) => {
        compromised = error
      },
    })
  } catch {
    throw new Error("Another installation is running; interrupted installations unlock after ten minutes")
  }
  try {
    return await action(() => {
      if (compromised) throw new Error("Installation ownership was lost")
    })
  } finally {
    if (!compromised) await release()
  }
}
