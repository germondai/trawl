import { blake2b } from "@noble/hashes/blake2b"
import { solveNativeFriendlyCaptcha } from "../utils/nativePow"

export interface FriendlyCaptchaPuzzle {
  signature: string
  puzzle: Uint8Array
  timestamp: number
  accountId: number
  appId: number
  version: number
  expiry: number
  nSolutions: number
  difficulty: number
  nonce: Uint8Array
}

export interface FriendlyCaptchaSolution {
  response: string
  elapsedMs: number
}

function difficultyToThreshold(difficulty: number): number {
  return Math.floor(2 ** ((255.999 - Math.min(255, Math.max(0, difficulty))) / 8))
}

function decodePuzzle(puzzleBase64: string): FriendlyCaptchaPuzzle | undefined {
  try {
    const puzzle = Uint8Array.from(atob(puzzleBase64), (c) => c.charCodeAt(0))
    if (puzzle.length < 32 || puzzle.length > 64) return undefined

    const view = new DataView(puzzle.buffer, puzzle.byteOffset, puzzle.byteLength)
    const timestamp = view.getUint32(0, false)
    const accountId = view.getUint32(4, false)
    const appId = view.getUint32(8, false)
    const version = puzzle[12]
    const expiry = puzzle[13]
    const nSolutions = puzzle[14]
    const difficulty = puzzle[15]
    const nonce = puzzle.slice(24, 32)

    if (nSolutions < 1 || nSolutions > 255) return undefined
    if (difficulty < 1 || difficulty > 255) return undefined

    return { signature: "", puzzle, timestamp, accountId, appId, version, expiry, nSolutions, difficulty, nonce }
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

export function solveFriendlyCaptchaV1(
  puzzleInput: string,
  maxIterations = 2 ** 26,
): FriendlyCaptchaSolution | undefined {
  const start = Date.now()
  const parts = puzzleInput.split(".")
  if (parts.length !== 2) return undefined

  const [signature, puzzleBase64] = parts
  const decoded = decodePuzzle(puzzleBase64)
  if (!decoded) return undefined

  const solutions = solvePuzzle(decoded.puzzle, decoded.difficulty, decoded.nSolutions, maxIterations)
  if (!solutions) return undefined

  const elapsedMs = Date.now() - start
  const response = buildResponse(signature, decoded.puzzle, solutions, elapsedMs)

  return { response, elapsedMs }
}

export async function solveFriendlyCaptchaV1Native(
  puzzleInput: string,
  timeoutMs = 60000,
  signal?: AbortSignal,
): Promise<FriendlyCaptchaSolution | undefined> {
  const start = Date.now()
  const parts = puzzleInput.split(".")
  if (parts.length !== 2) return undefined

  const [signature, puzzleBase64] = parts
  const decoded = decodePuzzle(puzzleBase64)
  if (!decoded) return undefined

  const nativeSolutions = await solveNativeFriendlyCaptcha(puzzleBase64, timeoutMs, signal)
  if (!nativeSolutions || nativeSolutions.length !== decoded.nSolutions) return undefined

  const solutions = new Uint8Array(decoded.nSolutions * 8)
  for (const sol of nativeSolutions) {
    const offset = sol.index * 8
    solutions[offset] = sol.index
    // bytes 1-3 stay 0
    solutions[offset + 4] = sol.nonce & 0xff
    solutions[offset + 5] = (sol.nonce >> 8) & 0xff
    solutions[offset + 6] = (sol.nonce >> 16) & 0xff
    solutions[offset + 7] = (sol.nonce >> 24) & 0xff
  }

  const elapsedMs = Date.now() - start
  const response = buildResponse(signature, decoded.puzzle, solutions, elapsedMs)

  return { response, elapsedMs }
}

export async function fetchAndSolveFriendlyCaptcha(
  sitekey: string,
  signal?: AbortSignal,
  useNative = true,
): Promise<FriendlyCaptchaSolution | undefined> {
  try {
    const response = await fetch(`https://api.friendlycaptcha.com/api/v1/puzzle?sitekey=${sitekey}`, {
      headers: { "x-frc-client": "trawl" },
      signal,
    })
    if (!response.ok) return undefined

    const data = (await response.json()) as { puzzle?: string }
    if (typeof data.puzzle !== "string") return undefined

    if (useNative) {
      const nativeResult = await solveFriendlyCaptchaV1Native(data.puzzle, 60000, signal)
      if (nativeResult) return nativeResult
    }

    return solveFriendlyCaptchaV1(data.puzzle)
  } catch {
    return undefined
  }
}

export function verifyFriendlyCaptchaSolution(puzzleInput: string, solution: string): boolean {
  const parts = solution.split(".")
  if (parts.length !== 4) return false

  const [signature, puzzleB64, solutionsB64] = parts
  if (signature !== puzzleInput.split(".")[0]) return false

  try {
    const puzzle = Uint8Array.from(atob(puzzleB64), (c) => c.charCodeAt(0))
    const solutions = Uint8Array.from(atob(solutionsB64), (c) => c.charCodeAt(0))
    const decoded = decodePuzzle(puzzleB64)
    if (!decoded) return false

    if (solutions.length !== decoded.nSolutions * 8) return false

    const threshold = difficultyToThreshold(decoded.difficulty)
    const padded = new Uint8Array(128)
    padded.set(puzzle)

    const seen = new Set<string>()
    for (let i = 0; i < decoded.nSolutions; i++) {
      const sol = solutions.slice(i * 8, (i + 1) * 8)
      const key = Array.from(sol).join(",")
      if (seen.has(key)) return false
      seen.add(key)

      padded.set(sol, 120)
      const hash = blake2b(padded, { dkLen: 32 })
      const hashValue = (hash[0] | (hash[1] << 8) | (hash[2] << 16) | (hash[3] << 24)) >>> 0
      if (hashValue >= threshold) return false
    }

    return true
  } catch {
    return false
  }
}
