import { dlopen, FFIType } from "bun:ffi"
import { createHash } from "node:crypto"
import { availableParallelism } from "node:os"

// Native proof-of-work walls solved at Tier 1, without a browser.
//
// The search runs in native/powsolve (Rust, loaded through bun:ffi). Without the
// library only the text-SHA-256 shape is solved, in JS; the other shapes fall back
// to the browser tiers as before.
//
// Recognized walls:
//   NCBI identity PoW (PubMed, PMC): sha256(`${challengeId}:${nonce}`), `bits` leading
//     zero bits, POST /_pow/solve, cookie N_POW_Challenge.
//   Anubis fast/slow:   sha256(randomData + nonce), `difficulty` leading zero hex digits.
//   Anubis sha256/argon2id/hashx: hex-decoded randomData as raw bytes, `difficulty` bits.
//   Anubis preact:      result = sha256hex(randomData) after difficulty*80 ms.
//   Anubis metarefresh: challenge = randomData after difficulty*800 ms.

const ALGO = { sha256: 0, argon2id: 1, hashx: 2 } as const

type NativeLib = {
  textSha256: (prefix: Uint8Array, bits: number, threads: number, out: Uint8Array) => number
  bytes: (algo: number, data: Uint8Array, bits: number, threads: number, out: Uint8Array) => number
}

let nativeLib: NativeLib | null | undefined

function loadNative(): NativeLib | null {
  if (nativeLib !== undefined) return nativeLib
  nativeLib = null
  const path = process.env.POWSOLVE_LIB ?? "/opt/powsolve/libpowsolve.so"
  try {
    const { symbols } = dlopen(path, {
      pow_text_sha256: {
        args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.i64_fast,
      },
      pow_bytes: {
        args: [FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.i64_fast,
      },
    })
    // Zero-length buffers cannot be passed as pointers; pad with one unread byte.
    const nonEmpty = (b: Uint8Array) => (b.length > 0 ? b : new Uint8Array(1))
    nativeLib = {
      textSha256: (prefix, bits, threads, out) =>
        Number(symbols.pow_text_sha256(nonEmpty(prefix), prefix.length, bits, threads, out)),
      bytes: (algo, data, bits, threads, out) =>
        Number(symbols.pow_bytes(algo, nonEmpty(data), data.length, bits, threads, out)),
    }
    console.log(`[native-pow] loaded ${path}`)
  } catch (err) {
    console.log(`[native-pow] native solver unavailable (${err instanceof Error ? err.message : err}); JS fallback`)
  }
  return nativeLib
}

const THREADS = Math.max(1, Math.min(8, availableParallelism()))

function leadingZeroBitsOk(hash: Uint8Array, bits: number): boolean {
  let remaining = bits
  for (const byte of hash) {
    if (remaining <= 0) return true
    if (remaining >= 8) {
      if (byte !== 0) return false
      remaining -= 8
    } else {
      return (byte & (0xff << (8 - remaining)) & 0xff) === 0
    }
  }
  return remaining <= 0
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex")

function solveTextSha256(prefix: string, bits: number): { nonce: number; hash: string } | undefined {
  const lib = loadNative()
  if (lib) {
    const out = new Uint8Array(32)
    const nonce = lib.textSha256(new TextEncoder().encode(prefix), bits, THREADS, out)
    return nonce < 0 ? undefined : { nonce, hash: toHex(out) }
  }
  // JS fallback, bounded so a hard wall does not stall the event loop.
  const limit = 2 ** Math.min(bits + 4, 24)
  for (let nonce = 0; nonce < limit; nonce++) {
    const hash = createHash("sha256").update(`${prefix}${nonce}`).digest()
    if (leadingZeroBitsOk(hash, bits)) return { nonce, hash: hash.toString("hex") }
  }
  return undefined
}

function solveBytes(algo: number, data: Uint8Array, bits: number): { nonce: number; hash: string } | undefined {
  const lib = loadNative()
  if (!lib) return undefined
  const out = new Uint8Array(32)
  const nonce = lib.bytes(algo, data, bits, THREADS, out)
  return nonce < 0 ? undefined : { nonce, hash: toHex(out) }
}

export interface PowPlan {
  kind: string
  // Milliseconds the server requires between issuing and submitting.
  waitMs: number
  // Builds the submit request after the wait. Solving happens here, synchronously.
  submit: () => { url: string; method: "GET" | "POST"; body?: string; contentType?: string } | undefined
}

export function looksLikePowWall(html: string): boolean {
  return html.includes("/_pow/solve") || html.includes("anubis_challenge")
}

const jsonScript = (html: string, id: string): unknown => {
  const m = html.match(new RegExp(`<script[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, "i"))
  if (!m) return null
  try {
    return JSON.parse(m[1] ?? "")
  } catch {
    return null
  }
}

function planNcbi(html: string, pageUrl: string): PowPlan | undefined {
  const id = html.match(/const\s+challengeId\s*=\s*"([^"]+)"/)?.[1]
  const bits = Number(html.match(/const\s+bits\s*=\s*(\d+)/)?.[1])
  if (!id || !Number.isFinite(bits) || !html.includes("/_pow/solve")) return undefined
  return {
    kind: `ncbi-pow(bits=${bits})`,
    waitMs: 0,
    submit: () => {
      const solved = solveTextSha256(`${id}:`, bits)
      if (!solved) return undefined
      return {
        url: new URL("/_pow/solve", pageUrl).href,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ challenge_id: id, nonce: String(solved.nonce), redirect_url: pageUrl }),
      }
    },
  }
}

function planAnubis(html: string, pageUrl: string): PowPlan | undefined {
  const data = jsonScript(html, "anubis_challenge") as {
    challenge?: { id?: string; randomData?: string }
    rules?: { algorithm?: string; difficulty?: number }
  } | null
  const id = data?.challenge?.id
  const randomData = data?.challenge?.randomData
  const algorithm = data?.rules?.algorithm
  const difficulty = Number(data?.rules?.difficulty ?? 0)
  if (!id || !randomData || !algorithm) return undefined

  const basePrefix = (jsonScript(html, "anubis_base_prefix") as string | null) ?? ""
  const publicUrl = jsonScript(html, "anubis_public_url") as string | null
  const page = new URL(pageUrl)
  const passUrl = new URL(`${basePrefix}/.within.website/x/cmd/anubis/api/pass-challenge`, page.origin)
  // Mirrors getRedirectUrl() in Anubis' web/js/main.ts.
  const redir =
    publicUrl === null
      ? "/"
      : publicUrl && pageUrl.startsWith(publicUrl)
        ? (page.searchParams.get("redir") ?? "/")
        : pageUrl
  const started = Date.now()

  if (algorithm === "preact" || algorithm === "metarefresh") {
    const perStep = algorithm === "preact" ? 80 : 800
    return {
      kind: `anubis-${algorithm}(difficulty=${difficulty})`,
      waitMs: difficulty * perStep + 150,
      submit: () => {
        // Server-side pages set redir to the request URI.
        passUrl.searchParams.set("redir", page.pathname + page.search)
        passUrl.searchParams.set("id", id)
        if (algorithm === "preact")
          passUrl.searchParams.set("result", createHash("sha256").update(randomData).digest("hex"))
        else passUrl.searchParams.set("challenge", randomData)
        return { url: passUrl.href, method: "GET" }
      },
    }
  }

  const solve = (): { nonce: number; hash: string } | undefined => {
    if (algorithm === "fast" || algorithm === "slow") return solveTextSha256(randomData, difficulty * 4)
    const algo = ALGO[algorithm as keyof typeof ALGO]
    if (algo === undefined || !/^[0-9a-f]*$/i.test(randomData) || randomData.length % 2) return undefined
    return solveBytes(algo, Buffer.from(randomData, "hex"), difficulty)
  }

  return {
    kind: `anubis-${algorithm}(difficulty=${difficulty})`,
    waitMs: 0,
    submit: () => {
      const solved = solve()
      if (!solved) return undefined
      passUrl.searchParams.set("id", id)
      passUrl.searchParams.set("response", solved.hash)
      passUrl.searchParams.set("nonce", String(solved.nonce))
      passUrl.searchParams.set("redir", redir)
      passUrl.searchParams.set("elapsedTime", String(Math.max(1, Date.now() - started)))
      return { url: passUrl.href, method: "GET" }
    },
  }
}

export function planPowWall(html: string, pageUrl: string): PowPlan | undefined {
  if (!looksLikePowWall(html)) return undefined
  return planNcbi(html, pageUrl) ?? planAnubis(html, pageUrl)
}

// "a=1; Path=/\nb=2; HttpOnly" -> ["a=1", "b=2"]
export function cookiePairs(setCookie: string | undefined): string[] {
  if (!setCookie) return []
  return setCookie
    .split("\n")
    .map((line) => line.split(";", 1)[0]?.trim() ?? "")
    .filter((pair) => pair.includes("="))
}

export function mergeCookieHeader(existing: string | undefined, pairs: string[]): string {
  const jar = new Map<string, string>()
  for (const part of (existing ?? "").split(";")) {
    const p = part.trim()
    const eq = p.indexOf("=")
    if (eq > 0) jar.set(p.slice(0, eq), p.slice(eq + 1))
  }
  for (const p of pairs) {
    const eq = p.indexOf("=")
    jar.set(p.slice(0, eq), p.slice(eq + 1))
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
}
