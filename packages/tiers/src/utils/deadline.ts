export class DeadlineError extends Error {
  constructor() {
    super("Scrape deadline exceeded")
    this.name = "DeadlineError"
  }
}

/** One operation budget, including cancellation of resources owned by the request. */
export class RequestBudget {
  readonly deadline: number
  readonly signal: AbortSignal
  private controller = new AbortController()
  private timer: ReturnType<typeof setTimeout>
  private cleanups = new Set<() => Promise<void>>()
  private cleaning?: Promise<void>

  constructor(ms: number) {
    this.deadline = Date.now() + Math.max(0, ms)
    this.signal = this.controller.signal
    this.timer = setTimeout(() => this.controller.abort(new DeadlineError()), Math.max(0, ms))
  }

  remaining(): number {
    return Math.max(0, this.deadline - Date.now())
  }

  check(): void {
    if (this.signal.aborted || this.remaining() <= 0) {
      this.controller.abort(new DeadlineError())
      throw new DeadlineError()
    }
  }

  own(cleanup: () => Promise<void>): () => void {
    this.cleanups.add(cleanup)
    if (this.signal.aborted) void cleanup().catch(() => {})
    return () => this.cleanups.delete(cleanup)
  }

  private drain(): Promise<void> {
    this.cleaning ??= Promise.allSettled([...this.cleanups].map((close) => Promise.resolve().then(close))).then(
      () => {},
    )
    return this.cleaning
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.check()
    let abort = () => {}
    try {
      return await Promise.race([
        Promise.resolve()
          .then(operation)
          .then(
            async (result) => {
              if (this.signal.aborted) {
                await this.drain()
                throw new DeadlineError()
              }
              this.check()
              return result
            },
            async (error) => {
              if (this.signal.aborted) {
                await this.drain()
                throw new DeadlineError()
              }
              throw error
            },
          ),
        new Promise<never>((_, reject) => {
          abort = () => {
            void this.drain().then(() => reject(new DeadlineError()))
          }
          this.signal.addEventListener("abort", abort, { once: true })
          if (this.signal.aborted) abort()
        }),
      ])
    } finally {
      this.signal.removeEventListener("abort", abort)
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
  }
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, Math.max(0, ms))
      abort = () => reject(signal?.reason ?? new DeadlineError())
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
    })
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}
