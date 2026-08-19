import type { CapturedResponseEntry } from "@trawl/types"
import type { Page, Response } from "patchright"

import { isTextContentType } from "./response"

// Captured bodies sit in memory next to a browser slot, so every dimension is bounded:
// how many patterns are honoured, how many bodies are kept, how big one body may be, how
// many bytes all of them together may take, and — because a read cannot be cut short once
// started — how large a body this process will agree to read at all. A body over its keep
// budget is trimmed and flagged `truncated`; anything past a cap is dropped whole. All
// caps are env-tunable.
const MAX_PATTERNS = Number(process.env.CAPTURE_MAX_RESPONSE_PATTERNS ?? 10)
const MAX_RESPONSES = Number(process.env.CAPTURE_MAX_RESPONSES ?? 5)
const MAX_BODY_BYTES = Number(process.env.CAPTURE_MAX_RESPONSE_BYTES ?? 5_242_880)
const MAX_TOTAL_BYTES = Number(process.env.CAPTURE_MAX_RESPONSE_TOTAL_BYTES ?? 10_485_760)
const BODY_TIMEOUT_MS = Number(process.env.CAPTURE_BODY_TIMEOUT_MS ?? 5_000)
// patchright 1.61 has no size-limited body read — see `onWireSize` — so a read is bounded
// by declining to start it. Trimming to `MAX_BODY_BYTES` still needs the body in hand, so
// the ceiling sits above that cap: past it the body is not read at all.
const MAX_READ_BYTES = Number(process.env.CAPTURE_MAX_READ_BYTES ?? MAX_BODY_BYTES * 2)
// A response of unknown length is charged this much while its read is in flight, so a
// chunked body is never admitted for free. Capped at one read's share of the budget it is
// charged against, so the floor never disables reads the read-count cap already bounds.
const UNKNOWN_BODY_BYTES = Number(process.env.CAPTURE_UNKNOWN_BODY_BYTES ?? 262_144)

// The settle window holds the page open after load so a late XHR still lands. It ends on
// the first match, on `waitForSelector`, on network idle, or at the deadline.
const SETTLE_MS = Number(process.env.CAPTURE_SETTLE_MS ?? 15_000)
const MAX_SETTLE_MS = Number(process.env.CAPTURE_MAX_SETTLE_MS ?? 60_000)
// A data fetch on a delayed timer is indistinguishable from a quiet network until it
// fires, so network idle is ignored for the first stretch of the window.
const IDLE_FLOOR_MS = Number(process.env.CAPTURE_SETTLE_IDLE_FLOOR_MS ?? 5_000)

const share = (budget: number, slots: number): number =>
  Math.min(UNKNOWN_BODY_BYTES, Math.floor(budget / Math.max(1, slots)))
const UNKNOWN_RESPONSE_CHARGE = share(MAX_TOTAL_BYTES, MAX_RESPONSES)

const NEVER = new Promise<void>(() => {})

export interface ResponseCaptureOptions {
  captureResponses?: string[]
  settleTimeout?: number
  waitForSelector?: string
}

export interface ResponseCapture {
  settle(budgetMs: number): Promise<void>
  drain(): Promise<CapturedResponseEntry[] | undefined>
}

const NO_RESPONSE_CAPTURE: ResponseCapture = { settle: async () => {}, drain: async () => undefined }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const declaredLength = (response: Response): number => Math.max(0, Number(response.headers()["content-length"]) || 0)

/**
 * The size the body took on the wire, or 0 when it cannot be known.
 *
 * patchright 1.61 exposes no size-limited body read: the `Response.body` protocol call
 * takes no parameters at all (`scheme.ResponseBodyParams = tOptional(tObject({}))`) and
 * answers with the whole decoded buffer, and the one chunked reader in the client,
 * `Stream.read({ size })`, hangs off artifacts and is unreachable from a response. So the
 * only way to bound a read is to decline to start it, and `Request.sizes()` is what makes
 * that decision possible for a chunked response: it reports the received body size even
 * where no `Content-Length` was sent. It settles when the request finishes, which is what
 * `body()` waits on anyway, so asking costs a protocol round trip and no extra wait.
 *
 * The size it reports is the encoded one; a compressed body still decodes to more than
 * this in the browser and again in this process, which no API here can cap.
 */
const onWireSize = async (response: Response): Promise<number> => {
  const declared = declaredLength(response)
  if (declared > 0) return declared
  try {
    return Math.max(0, (await response.request().sizes()).responseBodySize || 0)
  } catch {
    return 0
  }
}

/** A pattern with `*` or `?` is a glob matched against the whole URL, anything else a substring. */
const compile = (pattern: string): ((url: string) => boolean) => {
  if (!/[*?]/.test(pattern)) return (url) => url.includes(pattern)
  try {
    const expression = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    )
    return (url) => expression.test(url)
  } catch {
    return (url) => url.includes(pattern)
  }
}

const compilePatterns = (patterns: string[]): Array<(url: string) => boolean> => {
  const usable = patterns.filter((pattern) => typeof pattern === "string" && pattern.trim().length > 0)
  if (usable.length !== patterns.length || usable.length > MAX_PATTERNS) {
    console.log(`[capture] honouring ${Math.min(usable.length, MAX_PATTERNS)} of ${patterns.length} response patterns`)
  }
  return usable.slice(0, MAX_PATTERNS).map((pattern) => compile(pattern.trim()))
}

/**
 * Records the bodies of the responses whose URL matches a caller-supplied pattern.
 * Attaches nothing at all unless patterns were given, detaches on drain and again on
 * page close, and never throws into the caller — a body that cannot be read carries its
 * own `error` instead of failing the scrape.
 */
export function attachResponseCapture(page: Page, options: ResponseCaptureOptions): ResponseCapture {
  const patterns = options.captureResponses
  if (!Array.isArray(patterns) || patterns.length === 0) return NO_RESPONSE_CAPTURE

  const matchers = compilePatterns(patterns)
  if (matchers.length === 0) return NO_RESPONSE_CAPTURE

  const entries: CapturedResponseEntry[] = []
  const pending: Promise<void>[] = []
  const timers: ReturnType<typeof setTimeout>[] = []
  let bytesUsed = 0
  let inflightBytes = 0
  let dropped = 0
  let markFirstBody: () => void = () => {}
  const firstBody = new Promise<void>((resolve) => {
    markFirstBody = resolve
  })

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      timers.push(setTimeout(resolve, ms))
    })

  const encode = (raw: Buffer, contentType: string, entry: CapturedResponseEntry): void => {
    const budget = Math.min(MAX_BODY_BYTES, MAX_TOTAL_BYTES - bytesUsed)
    if (budget <= 0) {
      entry.error = "total capture budget exhausted"
      return
    }
    const kept = raw.length > budget ? raw.subarray(0, budget) : raw
    bytesUsed += kept.length
    entry.truncated = kept.length < raw.length
    // An unknown content type is encoded rather than decoded: base64 is lossless, while
    // reading arbitrary bytes as UTF-8 silently corrupts them.
    if (contentType && isTextContentType(contentType)) {
      entry.body = kept.toString("utf8").replace(/\uFFFD+$/, "")
    } else {
      entry.body = kept.toString("base64")
      entry.base64Encoded = true
    }
  }

  const readBody = async (response: Response, entry: CapturedResponseEntry, charged: number): Promise<void> => {
    let held = charged
    try {
      const size = await onWireSize(response)
      if (size > MAX_READ_BYTES) {
        entry.error = `body of ${size} bytes is past the ${MAX_READ_BYTES} byte read ceiling`
        return
      }
      // Measured before a byte is allocated, so the reads running at once are bounded by
      // the budget rather than by the number of matches times the ceiling.
      if (size > held) {
        if (inflightBytes + size - held > MAX_TOTAL_BYTES) {
          entry.error = "capture budget held by reads in flight"
          return
        }
        inflightBytes += size - held
        held = size
      }
      encode(await response.body(), response.headers()["content-type"] ?? "", entry)
      if (entry.body !== null) markFirstBody()
    } catch (err) {
      entry.error = `body read failed: ${message(err)}`
    } finally {
      inflightBytes -= held
    }
  }

  const onResponse = (response: Response) => {
    try {
      const url = response.url()
      if (!matchers.some((matches) => matches(url))) return
      // A redirect has no body of its own; the response it lands on is matched too.
      const status = response.status()
      if (status >= 300 && status < 400) return
      if (entries.length >= MAX_RESPONSES) {
        dropped++
        return
      }
      const entry: CapturedResponseEntry = {
        url,
        status,
        headers: response.headers(),
        body: null,
        base64Encoded: false,
        truncated: false,
      }
      entries.push(entry)
      const charge = Math.min(Math.max(declaredLength(response), UNKNOWN_RESPONSE_CHARGE), MAX_READ_BYTES)
      if (bytesUsed + inflightBytes + charge > MAX_TOTAL_BYTES) {
        entry.error = "total capture budget exhausted"
        return
      }
      inflightBytes += charge
      pending.push(readBody(response, entry, charge))
    } catch {
      dropped++
    }
  }

  const detach = () => {
    page.off("response", onResponse)
    page.off("close", detach)
  }

  page.on("response", onResponse)
  page.once("close", detach)

  return {
    async settle(budgetMs) {
      const windowMs = Math.min(options.settleTimeout ?? SETTLE_MS, MAX_SETTLE_MS, budgetMs)
      if (windowMs <= 0) return
      try {
        await Promise.race([
          firstBody,
          sleep(windowMs),
          options.waitForSelector
            ? page.waitForSelector(options.waitForSelector, { timeout: windowMs }).catch(() => NEVER)
            : NEVER,
          sleep(Math.min(IDLE_FLOOR_MS, windowMs)).then(() =>
            page.waitForLoadState("networkidle", { timeout: windowMs }).catch(() => NEVER),
          ),
        ])
      } catch (err) {
        console.log(`[capture] settle failed: ${message(err)}`)
      }
    },
    async drain() {
      detach()
      try {
        if (pending.length > 0) await Promise.race([Promise.all(pending), sleep(BODY_TIMEOUT_MS)])
        for (const entry of entries) {
          if (entry.body === null && !entry.error) entry.error = "body read did not complete"
        }
        if (dropped > 0) console.log(`[capture] dropped ${dropped} matched responses past the configured caps`)
      } catch (err) {
        console.log(`[capture] response drain failed: ${message(err)}`)
      } finally {
        for (const timer of timers) clearTimeout(timer)
      }
      return entries
    },
  }
}
