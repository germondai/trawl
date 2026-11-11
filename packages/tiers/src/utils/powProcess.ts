import { fileURLToPath } from "node:url"

let solving = false

// Share one killable process across all PoW protocols; never block the API loop.
export async function runPowProcess(input: unknown, timeoutMs = 1000, signal?: AbortSignal): Promise<unknown> {
  if (solving || signal?.aborted || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return
  const request = JSON.stringify(input)
  if (request.length > 16_384) return
  solving = true
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => child?.kill("SIGKILL")
  try {
    child = Bun.spawn(
      [process.execPath, "--no-env-file", fileURLToPath(new URL("./nativePowSolver.ts", import.meta.url))],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { PATH: process.env.PATH, POWSOLVE_LIB: process.env.POWSOLVE_LIB },
      },
    )
    timer = setTimeout(abort, Math.min(timeoutMs, 1000))
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    child.stdin.write(request)
    child.stdin.end()
    const output = await new Response(child.stdout).text()
    if ((await child.exited) !== 0 || signal?.aborted || output.length > 16_384) return
    return JSON.parse(output)
  } catch {
    return
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    if (child) {
      child.kill("SIGKILL")
      await child.exited
    }
    solving = false
  }
}
