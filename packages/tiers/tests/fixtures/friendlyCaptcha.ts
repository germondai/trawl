import { blake2b } from "@noble/hashes/blake2b"

// Protocol reference: FriendlyCaptcha/friendly-pow@4caf0912, encoding and puzzle layout.
export function friendlyPuzzle(difficulty = 1, count = 2) {
  const puzzle = Buffer.alloc(32)
  puzzle[12] = 1
  puzzle[14] = count
  puzzle[15] = difficulty
  return `server-signature.${puzzle.toString("base64")}`
}

export function verifyFriendlyProof(puzzle: string, response: string): boolean {
  const [signature, data, encoded, diagnostics] = response.split(".")
  if (`${signature}.${data}` !== puzzle || !diagnostics) return false
  const solutions = Buffer.from(encoded, "base64")
  const input = Buffer.alloc(128)
  Buffer.from(data, "base64").copy(input)
  if (solutions.length !== input[14] * 8) return false
  const threshold = Math.floor(2 ** ((255.999 - input[15]) / 8))
  for (let i = 0; i < input[14]; i++) {
    if (solutions.readUInt32LE(i * 8) !== i) return false
    solutions.copy(input, 120, i * 8, (i + 1) * 8)
    const hash = Buffer.from(blake2b(input, { dkLen: 32 }))
    if (hash.readUInt32LE() >= threshold) return false
  }
  return true
}
