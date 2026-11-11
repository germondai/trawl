import { dlopen, FFIType } from "bun:ffi"
import { createHash } from "node:crypto"

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
  } catch {
    // Local development can use text SHA-256 without the optional library.
  }
  return nativeLib
}

const THREADS = 1

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
  // The parent kills this process when its solve budget expires.
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

const input = JSON.parse(await Bun.stdin.text())
let result: unknown
if (input.task === "altcha") {
  const { solveAltchaPuzzle } = await import("../solvers/altchaPow")
  result = await solveAltchaPuzzle(input.challenge)
} else if (input.task === "friendly-captcha") {
  const { solveFriendlyCaptchaNative } = await import("../solvers/friendlyCaptchaPow")
  result = solveFriendlyCaptchaNative(input.puzzle, !input.nativeOnly)?.response
} else {
  result =
    input.algorithm === -1
      ? solveTextSha256(input.data, input.bits)
      : solveBytes(input.algorithm, Buffer.from(input.data, "hex"), input.bits)
}
process.stdout.write(JSON.stringify(result ?? null))
