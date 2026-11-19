import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout } from "node:timers/promises"
export async function installExclusive<T>(
  destination: string,
  action: (check: () => void) => Promise<T>,
  options: { wait?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const { default: lockfile } = await import("proper-lockfile")
  let compromised: Error | undefined
  let release: () => Promise<void>
  const deadline = Date.now() + (options.wait ? 30000 : 0)
  while (true) {
    options.signal?.throwIfAborted()
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
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline)
        throw new Error("Another installation is running; interrupted installations unlock after ten minutes")
      await setTimeout(100, undefined, { signal: options.signal })
    }
  }
  try {
    options.signal?.throwIfAborted()
    return await action(() => {
      options.signal?.throwIfAborted()
      if (compromised) throw new Error("Installation ownership was lost")
    })
  } finally {
    if (!compromised) await release()
  }
}

export function installAllExclusive<T>(destinations: string[], action: (check: () => void) => Promise<T>): Promise<T> {
  const checks: (() => void)[] = []
  const enter = (index: number): Promise<T> => {
    const destination = destinations[index]
    if (!destination)
      return action(() => {
        for (const check of checks) check()
      })
    return installExclusive(destination, async (check) => {
      checks.push(check)
      try {
        return await enter(index + 1)
      } finally {
        checks.pop()
      }
    })
  }
  return enter(0)
}
