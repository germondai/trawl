import { createHash, pbkdf2Sync, scryptSync } from "node:crypto"
import { runPowProcess } from "../utils/powProcess"

interface LegacyChallenge {
  algorithm: string
  salt: string
  challenge: string
  signature: string
  maxnumber?: number
}
interface Parameters {
  algorithm: string
  nonce: string
  salt: string
  cost: number
  keyLength: number
  keyPrefix: string
  memoryCost?: number
  parallelism?: number
  expiresAt?: number
}
export type AltchaChallenge = LegacyChallenge | { parameters: Parameters; signature?: string }
const integer = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max
const hex = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f\d]{2}){1,128}$/i.test(value)

// Expensive derivations run only in the child; limits are checked before allocation.
export async function solveAltchaPuzzle(input: AltchaChallenge): Promise<string | undefined> {
  const start = performance.now()
  if (!input || typeof input !== "object" || JSON.stringify(input).length > 8192) return
  if (!("parameters" in input)) {
    if (
      !/^SHA-(256|384|512)$/.test(input.algorithm) ||
      typeof input.salt !== "string" ||
      input.salt.length > 4096 ||
      typeof input.signature !== "string" ||
      !input.signature ||
      !hex(input.challenge)
    )
      return
    const max = input.maxnumber ?? 1_000_000
    if (!Number.isInteger(max) || max < 0 || max > 1_000_000) return
    for (let number = 0; number <= max; number++) {
      const digest = createHash(input.algorithm.replace("-", "").toLowerCase())
        .update(`${input.salt}${number}`)
        .digest("hex")
      if (digest === input.challenge) {
        return Buffer.from(
          JSON.stringify({
            algorithm: input.algorithm,
            challenge: input.challenge,
            salt: input.salt,
            signature: input.signature,
            number,
            took: performance.now() - start,
          }),
        ).toString("base64")
      }
    }
    return
  }
  const p = input.parameters
  if (
    !p ||
    !hex(p.nonce) ||
    !hex(p.salt) ||
    !integer(p.keyLength, 64) ||
    typeof p.keyPrefix !== "string" ||
    !/^[a-f\d]+$/i.test(p.keyPrefix) ||
    p.keyPrefix.length > p.keyLength * 2 ||
    !integer(p.cost, 1_000_000) ||
    (p.parallelism !== undefined && !integer(p.parallelism, 4)) ||
    (p.expiresAt !== undefined && (!Number.isFinite(p.expiresAt) || p.expiresAt * 1000 <= Date.now()))
  )
    return
  const sha = /^(?:PBKDF2\/)?SHA-(256|384|512)$/.exec(p.algorithm)
  if (!sha && !["SCRYPT", "ARGON2ID"].includes(p.algorithm)) return
  if (sha && p.keyLength > Number(sha[1]) / 8) return
  if (sha && !p.algorithm.startsWith("PBKDF2/") && p.cost > 10_000) return
  if (
    p.algorithm === "SCRYPT" &&
    (!integer(p.memoryCost, 32) ||
      p.cost < 2 ||
      (p.cost & (p.cost - 1)) !== 0 ||
      256 * p.cost * p.memoryCost > 64 * 1024 * 1024)
  )
    return
  if (
    p.algorithm === "ARGON2ID" &&
    (!integer(p.memoryCost, 32_768) || p.memoryCost < 8 * (p.parallelism ?? 1) || p.cost > 10)
  )
    return
  const salt = Buffer.from(p.salt, "hex")
  const password = Buffer.concat([Buffer.from(p.nonce, "hex"), Buffer.alloc(4)])
  for (let counter = 0; counter < 1_000_000; counter++) {
    password.writeUInt32BE(counter, password.length - 4)
    let derivedKey: string
    if (p.algorithm.startsWith("PBKDF2/") && sha) {
      derivedKey = pbkdf2Sync(password, salt, p.cost, p.keyLength, `sha${sha[1]}`).toString("hex")
    } else if (sha) {
      let data = Buffer.concat([salt, password])
      for (let i = 0; i < p.cost; i++) data = createHash(`sha${sha[1]}`).update(data).digest()
      derivedKey = data.subarray(0, p.keyLength).toString("hex")
    } else if (p.algorithm === "SCRYPT") {
      derivedKey = scryptSync(password, salt, p.keyLength, {
        N: p.cost,
        r: p.memoryCost,
        p: p.parallelism ?? 1,
        maxmem: 64 * 1024 * 1024,
      }).toString("hex")
    } else {
      const { argon2id } = await import("hash-wasm")
      derivedKey = await argon2id({
        password,
        salt,
        iterations: p.cost,
        memorySize: p.memoryCost as number,
        parallelism: p.parallelism ?? 1,
        hashLength: p.keyLength,
        outputType: "hex",
      })
    }
    if (derivedKey.startsWith(p.keyPrefix.toLowerCase())) {
      return Buffer.from(
        JSON.stringify({
          challenge: input,
          solution: { counter, derivedKey, time: Math.round(performance.now() - start) },
        }),
      ).toString("base64")
    }
  }
}
export async function solveAltcha(
  challenge: AltchaChallenge,
  timeoutMs = 1000,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await runPowProcess({ task: "altcha", challenge }, timeoutMs, signal)
  return typeof result === "string" && result.length <= 16_384 ? result : undefined
}
