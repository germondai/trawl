/** Managed child process: cancellation waits for exit before returning to the caller. */
export async function runSubprocess(
  command: string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number; stderr: string }> {
  signal?.throwIfAborted()
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const stderr = new Response(child.stderr).text()
  const abort = () => {
    child.kill("SIGKILL")
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  try {
    const exitCode = await child.exited
    signal?.throwIfAborted()
    return { exitCode, stderr: await stderr }
  } finally {
    signal?.removeEventListener("abort", abort)
    await stderr
  }
}

export function runFfmpeg(args: string[], signal?: AbortSignal) {
  const binary = process.env.FFMPEG_PATH?.trim() || "ffmpeg"
  return runSubprocess(
    [binary, "-nostdin", "-filter_threads", "1", "-filter_complex_threads", "1", "-threads", "1", ...args],
    signal,
  )
}
