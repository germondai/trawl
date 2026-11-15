// DataDome jspl payload encryption/decryption.
//
// The jspl parameter sent to api-js.datadome.co/js/ is an encrypted JSON payload
// containing browser fingerprint signals. This module implements the encryption
// scheme used by DataDome's client-side script.

// Constants from the DataDome script (from crypto.py)
const SEED_O = 1789537805
const SEED_E = 9959949970
const ENCRYPT_SEED = 1809053797
const IV_XOR_CONST = 11027890091
const DEFAULT_V = 741130091

// 6-bit encoding alphabet (base64url-like)
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const DECODE_MAP = new Map<string, number>()
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE_MAP.set(ALPHABET[i], i)
}

// 32-bit integer helpers (emulate JavaScript's 32-bit behavior)
export function toInt32(n: number): number {
  return n | 0
}

export function toUint32(n: number): number {
  return n >>> 0
}

// Convert float64 to int32 (truncate)
export function float64ToInt32(f: number): number {
  return toInt32(Math.trunc(f))
}

// XORShift32 PRNG
export function xorshift32(state: number): number {
  let x = toUint32(state)
  x ^= x << 13
  x = toUint32(x)
  x ^= x >>> 17
  x = toUint32(x)
  x ^= x << 5
  return toUint32(x)
}

// Java-style string hash: t = (t << 5) - t + charCode = t*31 + charCode
export function hashL(s: string): number {
  if (!s) return SEED_O
  let t = 0
  for (let i = 0; i < s.length; i++) {
    t = toInt32(toInt32(t << 5) - t + s.charCodeAt(i))
  }
  return t === 0 ? SEED_O : t
}

// DJB2 hash (used in tags.js S() function)
export function djb2Hash(s: string): number {
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = toUint32((hash << 5) + hash + s.charCodeAt(i))
  }
  return hash
}

// PRNG byte stream generator (matches Python crypto.py)
export class PRNGStream {
  private c: number // state
  private e: number // byte counter (0-2)
  private i: number // IV counter
  private r: boolean // xor with IV
  private cached: number | null = null

  constructor(seed: number, xorWithIv = false, iv = 0) {
    this.c = toInt32(seed)
    this.e = -1
    this.i = toInt32(iv)
    this.r = xorWithIv
  }

  next(peek = false): number {
    if (this.cached !== null) {
      const t = this.cached
      this.cached = null
      return t
    }

    this.e++
    if (this.e > 2) {
      this.c = xorshift32(this.c)
      this.e = 0
    }

    const shift = 16 - 8 * this.e
    const raw = shift >= 0 ? toInt32(this.c) >> shift : toInt32(this.c) << -shift

    let ivVal = 0
    if (this.r) {
      this.i = toInt32(this.i - 1)
      ivVal = this.i
    }

    const t = (raw ^ ivVal) & 0xff

    if (peek) {
      this.cached = t
    }
    return t
  }

  nextByte(): number {
    return this.next()
  }

  nextBytes(n: number): number[] {
    const result: number[] = []
    for (let i = 0; i < n; i++) {
      result.push(this.next())
    }
    return result
  }
}

// 6-bit encode (matches Python w_encode)
export function wEncode(bytes: number[]): string {
  const output: string[] = []
  let rPos = 0

  while (rPos < bytes.length) {
    const b0 = rPos < bytes.length ? bytes[rPos] : 0
    const b1 = rPos + 1 < bytes.length ? bytes[rPos + 1] : 0
    const b2 = rPos + 2 < bytes.length ? bytes[rPos + 2] : 0

    const combined = (b0 << 16) | (b1 << 8) | b2

    output.push(String.fromCharCode(wEncodeChar((combined >> 18) & 63)))
    output.push(String.fromCharCode(wEncodeChar((combined >> 12) & 63)))
    output.push(String.fromCharCode(wEncodeChar((combined >> 6) & 63)))
    output.push(String.fromCharCode(wEncodeChar(combined & 63)))

    rPos += 3
  }

  const remainder = bytes.length % 3
  if (remainder) {
    return output.slice(0, -(3 - remainder)).join("")
  }
  return output.join("")
}

// 6-bit decode (matches Python w_decode)
export function wDecode(s: string): number[] {
  const raw6bit = s.split("").map((ch) => wDecodeChar(ch.charCodeAt(0)))

  const numChars = raw6bit.length
  const fullGroups = Math.floor(numChars / 4)
  const remaining = numChars % 4

  let origByteCount: number
  if (remaining === 3) {
    origByteCount = fullGroups * 3 + 2
  } else if (remaining === 2) {
    origByteCount = fullGroups * 3 + 1
  } else {
    origByteCount = fullGroups * 3
  }

  // Pad to multiple of 4
  while (raw6bit.length % 4 !== 0) {
    raw6bit.push(0)
  }

  const encodedBytes: number[] = []
  for (let g = 0; g < raw6bit.length / 4; g++) {
    const combined =
      (raw6bit[g * 4] << 18) | (raw6bit[g * 4 + 1] << 12) | (raw6bit[g * 4 + 2] << 6) | raw6bit[g * 4 + 3]
    encodedBytes.push((combined >> 16) & 255)
    encodedBytes.push((combined >> 8) & 255)
    encodedBytes.push(combined & 255)
  }

  return encodedBytes.slice(0, origByteCount)
}

// Decode single char (matches Python w_decode)
function wDecodeChar(code: number): number {
  if (code === 45) return 0 // '-'
  if (code === 95) return 1 // '_'
  if (code >= 48 && code <= 57) return code - 46 // '0'-'9'
  if (code >= 65 && code <= 90) return code - 53 // 'A'-'Z'
  if (code >= 97 && code <= 122) return code - 59 // 'a'-'z'
  throw new Error(`Invalid encoded char: ${String.fromCharCode(code)} (${code})`)
}

// Encrypt a signal dictionary into jspl format (matches Python crypto.py)
export function encrypt(
  signals: Record<string, unknown>,
  ddjskey: string,
  cid: string | null = null,
  timestampMs = Date.now(),
): string {
  // Derive n_key from ddjskey
  const nKey = toInt32(toInt32(SEED_E) ^ hashL(ddjskey) ^ DEFAULT_V)

  // Derive f from timestamp
  const tsShifted = toInt32(toInt32(timestampMs) >> 3 ^ toInt32(IV_XOR_CONST))
  const inner = xorshift32(tsShifted)
  const product = inner * SEED_E
  const f = xorshift32(float64ToInt32(product))

  // Create s_prng with xor_with_iv=true
  const sPrng = new PRNGStream(nKey, true, f)

  // Serialize signals as JSON key-value pairs
  const d: number[] = []
  let first = true

  for (const [key, value] of Object.entries(signals)) {
    if (typeof key !== "string" || key.length === 0) continue
    if (value !== null && typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") continue

    const keyJson = JSON.stringify(key)
    const valJson = JSON.stringify(value)

    // Separator: { for first, , for others
    const separator = first ? 123 : 44 // '{' or ','
    d.push(sPrng.next() ^ separator)

    // Key
    const keyBytes = new TextEncoder().encode(keyJson)
    for (const b of keyBytes) {
      d.push(b ^ sPrng.next())
    }

    // Colon
    d.push(58 ^ sPrng.next()) // ':'

    // Value
    const valBytes = new TextEncoder().encode(valJson)
    for (const b of valBytes) {
      d.push(b ^ sPrng.next())
    }

    first = false
  }

  // Create t_prng with xor_with_iv=false
  const tPrng = new PRNGStream(toInt32(ENCRYPT_SEED ^ hashL(cid ?? "")), false, f)

  // XOR with t_prng
  const c = d.map((byte) => byte ^ tPrng.next())

  // Closing brace (peek from s_prng)
  c.push((125 ^ sPrng.next(true)) ^ tPrng.next()) // '}'

  // Apply rolling mask with a_iv
  const output: string[] = []
  let aIv = toInt32(f)
  let rPos = 0

  while (rPos < c.length) {
    const b0 = rPos < c.length ? c[rPos] : 0
    const b1 = rPos + 1 < c.length ? c[rPos + 1] : 0
    const b2 = rPos + 2 < c.length ? c[rPos + 2] : 0

    aIv = toInt32(aIv - 1)
    const v0 = (aIv & 0xff) ^ b0
    aIv = toInt32(aIv - 1)
    const v1 = (aIv & 0xff) ^ b1
    aIv = toInt32(aIv - 1)
    const v2 = (aIv & 0xff) ^ b2

    const uCombined = (v0 << 16) | (v1 << 8) | v2

    output.push(String.fromCharCode(wEncodeChar((uCombined >> 18) & 63)))
    output.push(String.fromCharCode(wEncodeChar((uCombined >> 12) & 63)))
    output.push(String.fromCharCode(wEncodeChar((uCombined >> 6) & 63)))
    output.push(String.fromCharCode(wEncodeChar(uCombined & 63)))

    rPos += 3
  }

  // Trim trailing chars based on remainder
  const remainder = c.length % 3
  if (remainder) {
    return output.slice(0, -(3 - remainder)).join("")
  }
  return output.join("")
}

// Single-byte w_encode (matches Python)
function wEncodeChar(n: number): number {
  if (n > 37) return 59 + n
  if (n > 11) return 53 + n
  if (n > 1) return 46 + n
  return 50 * n + 45
}

// Decrypt jspl string back to signals (brute-force f_low, matches Python)
export function decrypt(
  jspl: string,
  ddjskey: string,
  cid: string | null = null,
): Record<string, unknown> | undefined {
  // URL decode and clean
  const cleaned = decodeURIComponent(jspl.trim().replace(/[\n\r ]/g, ""))

  // Decode from 6-bit
  const encodedBytes = wDecode(cleaned)
  if (encodedBytes.length === 0) return undefined

  // Derive keys
  const nKey = toInt32(toInt32(SEED_E) ^ hashL(ddjskey) ^ DEFAULT_V)
  const tSeed = toInt32(ENCRYPT_SEED ^ hashL(cid ?? ""))

  // Brute-force f_low (0-255)
  for (let fLow = 0; fLow < 256; fLow++) {
    try {
      // Remove rolling mask (reverse of encryption)
      let aCounter = fLow
      const cBytes: number[] = []
      for (const byte of encodedBytes) {
        aCounter = (aCounter - 1) & 0xff
        cBytes.push(byte ^ aCounter)
      }

      // Create t_prng (xor_with_iv=false)
      const tTest = new PRNGStream(tSeed, false, 0)
      const dBytes = cBytes.map((b) => b ^ tTest.next())

      // Create s_prng (xor_with_iv=true) and check first byte
      const sTest = new PRNGStream(nKey, true, fLow)
      const firstByte = dBytes[0] ^ sTest.next()

      if (firstByte !== 123) continue // '{'

      // Full decryption
      const sFull = new PRNGStream(nKey, true, fLow)
      const plaintextBytes = dBytes.map((b) => b ^ sFull.next())

      const text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(plaintextBytes))
      if (text.startsWith("{") && text.endsWith("}")) {
        const parsed = JSON.parse(text)
        return parsed as Record<string, unknown>
      }
    } catch {
      continue
    }
  }

  return undefined
}
