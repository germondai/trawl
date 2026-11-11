import { createHash, pbkdf2Sync, scryptSync } from "node:crypto"
import { argon2id } from "hash-wasm"

export type AltchaAlgorithm =
  | "SHA-256"
  | "SHA-384"
  | "SHA-512"
  | "PBKDF2-SHA-256"
  | "PBKDF2-SHA-384"
  | "PBKDF2-SHA-512"
  | "SCRYPT"
  | "ARGON2ID"

export interface AltchaChallenge {
  algorithm: AltchaAlgorithm
  salt: string
  challenge?: string
  keyPrefix?: string
  cost?: number
  memoryCost?: number
  parallelism?: number
}

export interface AltchaSolution {
  challenge: AltchaChallenge
  solution: {
    counter: number
    derivedKey: string
    time: number
  }
}

const HASH_LENGTHS: Record<string, number> = {
  "SHA-256": 32,
  "SHA-384": 48,
  "SHA-512": 64,
}

function normalizeAlgorithm(algo: string): AltchaAlgorithm | undefined {
  const normalized = algo.toUpperCase().replace(/[^A-Z0-9-]/g, "")
  const map: Record<string, AltchaAlgorithm> = {
    SHA256: "SHA-256",
    "SHA-256": "SHA-256",
    SHA384: "SHA-384",
    "SHA-384": "SHA-384",
    SHA512: "SHA-512",
    "SHA-512": "SHA-512",
    "PBKDF2-SHA256": "PBKDF2-SHA-256",
    "PBKDF2-SHA-256": "PBKDF2-SHA-256",
    "PBKDF2-SHA384": "PBKDF2-SHA-384",
    "PBKDF2-SHA-384": "PBKDF2-SHA-384",
    "PBKDF2-SHA512": "PBKDF2-SHA-512",
    "PBKDF2-SHA-512": "PBKDF2-SHA-512",
    SCRYPT: "SCRYPT",
    ARGON2ID: "ARGON2ID",
    "ARGON2-ID": "ARGON2ID",
    ARGON2: "ARGON2ID",
  }
  return map[normalized]
}

function buildPassword(nonceHex: string, counter: number): Buffer {
  const nonceBytes = Buffer.from(nonceHex, "hex")
  const counterBytes = Buffer.alloc(4)
  counterBytes.writeUInt32BE(counter, 0)
  return Buffer.concat([nonceBytes, counterBytes])
}

function solveShaChallenge(
  hashName: string,
  salt: string,
  challenge: string,
  maxIterations: number,
): { counter: number; derivedKey: string } | undefined {
  for (let counter = 0; counter < maxIterations; counter++) {
    const input = `${salt}${counter}`
    const hash = createHash(hashName.toLowerCase().replace("-", "")).update(input).digest("hex")
    if (hash === challenge) {
      return { counter, derivedKey: hash }
    }
  }
  return undefined
}

function solveShaPrefix(
  hashName: string,
  salt: string,
  keyPrefix: string,
  maxIterations: number,
): { counter: number; derivedKey: string } | undefined {
  const hashAlgo = hashName.toLowerCase().replace("-", "")
  const saltBytes = Buffer.from(salt, "hex")

  for (let counter = 0; counter < maxIterations; counter++) {
    const password = buildPassword(salt, counter)
    const hash = createHash(hashAlgo)
      .update(Buffer.concat([saltBytes, password]))
      .digest("hex")
    if (hash.startsWith(keyPrefix)) {
      return { counter, derivedKey: hash }
    }
  }
  return undefined
}

function solvePbkdf2(
  hashName: string,
  salt: string,
  keyPrefix: string,
  cost: number,
  maxIterations: number,
): { counter: number; derivedKey: string } | undefined {
  const baseHash = hashName.replace("PBKDF2-", "")
  const keyLength = HASH_LENGTHS[baseHash] ?? 32
  const hashAlgo = baseHash.toLowerCase().replace("-", "")
  const saltBytes = Buffer.from(salt, "hex")

  for (let counter = 0; counter < maxIterations; counter++) {
    const password = buildPassword(salt, counter)
    const key = pbkdf2Sync(password, saltBytes, cost, keyLength, hashAlgo)
    const keyHex = key.toString("hex")
    if (keyHex.startsWith(keyPrefix)) {
      return { counter, derivedKey: keyHex }
    }
  }
  return undefined
}

function solveScrypt(
  salt: string,
  keyPrefix: string,
  n: number,
  r: number,
  p: number,
  maxIterations: number,
): { counter: number; derivedKey: string } | undefined {
  const saltBytes = Buffer.from(salt, "hex")
  const keyLength = 32

  for (let counter = 0; counter < maxIterations; counter++) {
    const password = buildPassword(salt, counter)
    const key = scryptSync(password, saltBytes, keyLength, { N: n, r, p })
    const keyHex = key.toString("hex")
    if (keyHex.startsWith(keyPrefix)) {
      return { counter, derivedKey: keyHex }
    }
  }
  return undefined
}

async function solveArgon2id(
  salt: string,
  keyPrefix: string,
  timeCost: number,
  memoryCost: number,
  parallelism: number,
  maxIterations: number,
): Promise<{ counter: number; derivedKey: string } | undefined> {
  const saltBytes = Buffer.from(salt, "hex")

  for (let counter = 0; counter < maxIterations; counter++) {
    const password = buildPassword(salt, counter)
    const key = await argon2id({
      password,
      salt: saltBytes,
      iterations: timeCost,
      memorySize: memoryCost,
      parallelism,
      hashLength: 32,
      outputType: "hex",
    })
    if (key.startsWith(keyPrefix)) {
      return { counter, derivedKey: key }
    }
  }
  return undefined
}

export async function solveAltcha(
  challenge: AltchaChallenge,
  maxIterations = 100000,
): Promise<AltchaSolution | undefined> {
  const start = Date.now()
  const algorithm = normalizeAlgorithm(challenge.algorithm)
  if (!algorithm) return undefined

  const { salt, keyPrefix = "", cost = 2000, memoryCost = 8, parallelism = 1 } = challenge
  let result: { counter: number; derivedKey: string } | undefined

  if (algorithm === "SHA-256" || algorithm === "SHA-384" || algorithm === "SHA-512") {
    if (challenge.challenge) {
      result = solveShaChallenge(algorithm, salt, challenge.challenge, maxIterations)
    } else if (keyPrefix) {
      result = solveShaPrefix(algorithm, salt, keyPrefix, maxIterations)
    }
  } else if (algorithm.startsWith("PBKDF2-")) {
    if (!keyPrefix) return undefined
    result = solvePbkdf2(algorithm, salt, keyPrefix, cost, maxIterations)
  } else if (algorithm === "SCRYPT") {
    if (!keyPrefix) return undefined
    const n = cost || 16384
    const r = memoryCost || 8
    const p = parallelism || 1
    result = solveScrypt(salt, keyPrefix, n, r, p, maxIterations)
  } else if (algorithm === "ARGON2ID") {
    if (!keyPrefix) return undefined
    const t = cost || 3
    const m = memoryCost || 65536
    const p = parallelism || 1
    result = await solveArgon2id(salt, keyPrefix, t, m, p, maxIterations)
  }

  if (!result) return undefined

  return {
    challenge,
    solution: {
      counter: result.counter,
      derivedKey: result.derivedKey,
      time: Date.now() - start,
    },
  }
}

export function buildAltchaPayload(solution: AltchaSolution): string {
  const payload = {
    challenge: solution.challenge.challenge || `${solution.challenge.salt}:${solution.challenge.keyPrefix}`,
    solution: solution.solution.counter,
  }
  return btoa(JSON.stringify(payload))
}

export async function verifyAltchaSolution(challenge: AltchaChallenge, counter: number): Promise<boolean> {
  const algorithm = normalizeAlgorithm(challenge.algorithm)
  if (!algorithm) return false

  const { salt, keyPrefix = "", cost = 2000, memoryCost = 8, parallelism = 1 } = challenge

  if (algorithm === "SHA-256" || algorithm === "SHA-384" || algorithm === "SHA-512") {
    if (challenge.challenge) {
      const hashAlgo = algorithm.toLowerCase().replace("-", "")
      const input = `${salt}${counter}`
      const hash = createHash(hashAlgo).update(input).digest("hex")
      return hash === challenge.challenge
    } else if (keyPrefix) {
      const hashAlgo = algorithm.toLowerCase().replace("-", "")
      const saltBytes = Buffer.from(salt, "hex")
      const password = buildPassword(salt, counter)
      const hash = createHash(hashAlgo)
        .update(Buffer.concat([saltBytes, password]))
        .digest("hex")
      return hash.startsWith(keyPrefix)
    }
  } else if (algorithm.startsWith("PBKDF2-")) {
    if (!keyPrefix) return false
    const baseHash = algorithm.replace("PBKDF2-", "")
    const keyLength = HASH_LENGTHS[baseHash] ?? 32
    const hashAlgo = baseHash.toLowerCase().replace("-", "")
    const saltBytes = Buffer.from(salt, "hex")
    const password = buildPassword(salt, counter)
    const key = pbkdf2Sync(password, saltBytes, cost, keyLength, hashAlgo)
    return key.toString("hex").startsWith(keyPrefix)
  } else if (algorithm === "SCRYPT") {
    if (!keyPrefix) return false
    const saltBytes = Buffer.from(salt, "hex")
    const password = buildPassword(salt, counter)
    const n = cost || 16384
    const r = memoryCost || 8
    const p = parallelism || 1
    const key = scryptSync(password, saltBytes, 32, { N: n, r, p })
    return key.toString("hex").startsWith(keyPrefix)
  } else if (algorithm === "ARGON2ID") {
    if (!keyPrefix) return false
    const saltBytes = Buffer.from(salt, "hex")
    const password = buildPassword(salt, counter)
    const t = cost || 3
    const m = memoryCost || 65536
    const p = parallelism || 1
    const key = await argon2id({
      password,
      salt: saltBytes,
      iterations: t,
      memorySize: m,
      parallelism: p,
      hashLength: 32,
      outputType: "hex",
    })
    return key.startsWith(keyPrefix)
  }

  return false
}
