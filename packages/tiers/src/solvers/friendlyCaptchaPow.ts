import { dlopen, FFIType } from "bun:ffi"
import { blake2b } from "@noble/hashes/blake2b"
import { runPowProcess } from "../utils/powProcess"

export interface FriendlyCaptchaSolution {
  response: string
  elapsedMs: number
}

function difficultyToThreshold(difficulty: number): number {
  return Math.floor(2 ** ((255.999 - Math.min(255, Math.max(0, difficulty))) / 8))
}

function decodePuzzle(
  puzzleBase64: string,
): { puzzle: Uint8Array; nSolutions: number; difficulty: number } | undefined {
  try {
    const puzzle = Uint8Array.from(atob(puzzleBase64), (c) => c.charCodeAt(0))
    if (puzzle.length < 32 || puzzle.length > 64) return undefined

    const nSolutions = puzzle[14]
    const difficulty = puzzle[15]

    if (nSolutions < 1 || nSolutions > 255) return undefined

    return { puzzle, nSolutions, difficulty }
  } catch {
    return undefined
  }
}

function solvePuzzle(
  puzzle: Uint8Array,
  difficulty: number,
  nSolutions: number,
  maxIterations = 2 ** 26,
): Uint8Array | undefined {
  const threshold = difficultyToThreshold(difficulty)
  const solutions = new Uint8Array(nSolutions * 8)
  const padded = new Uint8Array(128)
  padded.set(puzzle)

  for (let i = 0; i < nSolutions; i++) {
    padded[120] = i
    padded[121] = 0
    padded[122] = 0
    padded[123] = 0
    let found = false

    for (let counter = 0; counter < maxIterations; counter++) {
      padded[124] = counter & 0xff
      padded[125] = (counter >> 8) & 0xff
      padded[126] = (counter >> 16) & 0xff
      padded[127] = (counter >> 24) & 0xff

      const hash = blake2b(padded, { dkLen: 32 })
      const hashValue = (hash[0] | (hash[1] << 8) | (hash[2] << 16) | (hash[3] << 24)) >>> 0

      if (hashValue < threshold) {
        solutions.set(padded.slice(120, 128), i * 8)
        found = true
        break
      }
    }

    if (!found) return undefined
  }

  return solutions
}

function buildResponse(signature: string, puzzle: Uint8Array, solutions: Uint8Array, elapsedMs: number): string {
  const puzzleB64 = btoa(String.fromCharCode(...puzzle))
  const solutionsB64 = btoa(String.fromCharCode(...solutions))
  const elapsedSec = Math.min(65535, Math.ceil(elapsedMs / 1000))
  const diagnostics = new Uint8Array([0x01, (elapsedSec >> 8) & 0xff, elapsedSec & 0xff])
  const diagnosticsB64 = btoa(String.fromCharCode(...diagnostics))
  return `${signature}.${puzzleB64}.${solutionsB64}.${diagnosticsB64}`
}

export function solveFriendlyCaptchaPuzzle(
  puzzleInput: string,
  maxIterations = 2 ** 26,
): FriendlyCaptchaSolution | undefined {
  const start = Date.now()
  if (puzzleInput.length > 2048) return
  const parts = puzzleInput.split(".")
  if (parts.length !== 2 || !parts[0]) return undefined

  const [signature, puzzleBase64] = parts
  const decoded = decodePuzzle(puzzleBase64)
  if (!decoded) return undefined

  const solutions = solvePuzzle(decoded.puzzle, decoded.difficulty, decoded.nSolutions, maxIterations)
  if (!solutions) return undefined

  const elapsedMs = Date.now() - start
  const response = buildResponse(signature, decoded.puzzle, solutions, elapsedMs)

  return { response, elapsedMs }
}

export async function solveFriendlyCaptchaV1(
  puzzleInput: string,
  timeoutMs = 1000,
  signal?: AbortSignal,
): Promise<FriendlyCaptchaSolution | undefined> {
  const start = Date.now()
  if (puzzleInput.length > 2048) return
  const result = await runPowProcess({ task: "friendly-captcha", puzzle: puzzleInput }, timeoutMs, signal)
  if (typeof result === "string" && result.startsWith(`${puzzleInput}.`) && result.length <= 8192) {
    return { response: result, elapsedMs: Date.now() - start }
  }
}

// Runs only inside the bounded child, with one native thread or a JS fallback.
export function solveFriendlyCaptchaNative(
  puzzleInput: string,
  allowFallback = true,
): FriendlyCaptchaSolution | undefined {
  const start = Date.now()
  const parts = puzzleInput.split(".")
  if (parts.length !== 2 || !parts[0]) return
  const decoded = decodePuzzle(parts[1])
  if (!decoded) return
  let close: (() => void) | undefined
  try {
    const lib = dlopen(process.env.POWSOLVE_LIB ?? "/opt/powsolve/libpowsolve.so", {
      pow_friendly_captcha: {
        args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
    })
    close = () => lib.close()
    const out = new Uint8Array(decoded.nSolutions * 5)
    const count = lib.symbols.pow_friendly_captcha(decoded.puzzle, decoded.puzzle.length, 1, out)
    if (count !== decoded.nSolutions) return
    const solutions = new Uint8Array(decoded.nSolutions * 8)
    for (let i = 0; i < count; i++) {
      if (out[i * 5] !== i) return
      solutions[i * 8] = i
      solutions.set(out.subarray(i * 5 + 1, i * 5 + 5), i * 8 + 4)
    }
    const elapsedMs = Date.now() - start
    return { response: buildResponse(parts[0], decoded.puzzle, solutions, elapsedMs), elapsedMs }
  } catch {
    return allowFallback ? solveFriendlyCaptchaPuzzle(puzzleInput) : undefined
  } finally {
    close?.()
  }
}

export async function fetchAndSolveFriendlyCaptcha(
  sitekey: string,
  fetchJson: (url: string) => Promise<unknown>,
  timeoutMs = 1000,
  signal?: AbortSignal,
  endpoint = "https://api.friendlycaptcha.com/api/v1/puzzle",
): Promise<FriendlyCaptchaSolution | undefined> {
  const deadline = Date.now() + timeoutMs
  if (signal?.aborted || timeoutMs <= 0 || !sitekey || sitekey.length > 256) return
  const url = new URL(endpoint)
  url.searchParams.set("sitekey", sitekey)
  const result = (await fetchJson(url.href)) as { data?: { puzzle?: unknown } } | undefined
  if (typeof result?.data?.puzzle !== "string") return
  return solveFriendlyCaptchaV1(result.data.puzzle, deadline - Date.now(), signal)
}
