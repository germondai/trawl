import { expect, test } from "bun:test"
import { createHash, pbkdf2Sync, scryptSync } from "node:crypto"
import { argon2id } from "hash-wasm"
import { type AltchaChallenge, solveAltcha } from "../src/solvers/altchaPow"

// Protocol reference: altcha-org/altcha-lib@80289d26, src/v1 and src/v2/algorithms.
test.each(["SHA-256", "SHA-384", "SHA-512"])("ALTCHA legacy %s preserves the signed challenge", async (algorithm) => {
  const challenge = {
    algorithm,
    salt: "server-salt",
    signature: "server-signature",
    maxnumber: 3,
    challenge: createHash(algorithm.replace("-", "").toLowerCase()).update("server-salt3").digest("hex"),
  }
  const proof = await solveAltcha(challenge)
  expect(proof).toBeDefined()
  const payload = JSON.parse(Buffer.from(proof as string, "base64").toString())
  const { maxnumber: _max, ...signed } = challenge
  expect(payload).toMatchObject({ ...signed, number: 3 })
})

test.each([
  "SHA-256",
  "SHA-384",
  "SHA-512",
  "PBKDF2/SHA-256",
  "PBKDF2/SHA-384",
  "PBKDF2/SHA-512",
  "SCRYPT",
  "ARGON2ID",
])("ALTCHA prefix protocol %s returns a verifiable key", async (algorithm) => {
  const salt = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex")
  const password = Buffer.from("1112131415161718191a1b1c1d1e1f2000000001", "hex")
  const cost = algorithm === "SCRYPT" ? 16 : 2
  let key: string
  if (algorithm === "ARGON2ID") {
    key = await argon2id({
      password,
      salt,
      iterations: cost,
      memorySize: 32,
      parallelism: 1,
      hashLength: 32,
      outputType: "hex",
    })
  } else if (algorithm === "SCRYPT") {
    key = scryptSync(password, salt, 32, { N: cost, r: 1, p: 1 }).toString("hex")
  } else if (algorithm.startsWith("PBKDF2/")) {
    key = pbkdf2Sync(password, salt, cost, 32, algorithm.slice(7).replace("-", "").toLowerCase()).toString("hex")
  } else {
    const hash = algorithm.replace("-", "").toLowerCase()
    key = createHash(hash)
      .update(
        createHash(hash)
          .update(Buffer.concat([salt, password]))
          .digest(),
      )
      .digest()
      .subarray(0, 32)
      .toString("hex")
  }
  const challenge = {
    parameters: {
      algorithm,
      nonce: password.subarray(0, 16).toString("hex"),
      salt: salt.toString("hex"),
      cost,
      keyLength: 32,
      keyPrefix: key,
      memoryCost: algorithm === "SCRYPT" ? 1 : 32,
      parallelism: 1,
    },
    signature: "server-signature",
  }
  const proof = await solveAltcha(challenge)
  expect(proof).toBeDefined()
  const payload = JSON.parse(Buffer.from(proof as string, "base64").toString())
  expect(payload.challenge).toEqual(challenge)
  expect(payload.solution).toMatchObject({ counter: 1, derivedKey: key })
})

test("rejects malformed and excessive ALTCHA parameters without allocating their requested memory", async () => {
  for (const challenge of [
    null,
    {},
    { algorithm: "SHA-256", salt: "salt", challenge: "ab" },
    {
      parameters: {
        algorithm: "ARGON2ID",
        nonce: "11",
        salt: "22",
        keyPrefix: "00",
        keyLength: 32,
        cost: 1,
        memoryCost: 2 ** 30,
      },
    },
    {
      parameters: {
        algorithm: "SCRYPT",
        nonce: "11",
        salt: "22",
        keyPrefix: "00",
        keyLength: 32,
        cost: 2 ** 30,
        memoryCost: 8,
      },
    },
  ])
    expect(await solveAltcha(challenge as AltchaChallenge)).toBeUndefined()
})

test("interrupts expensive ALTCHA work and releases the shared solver slot", async () => {
  const controller = new AbortController()
  const started = Date.now()
  const solving = solveAltcha(
    { algorithm: "SHA-512", salt: "slow", challenge: "ff".repeat(64), signature: "signature" },
    50,
    controller.signal,
  )
  let heartbeat = false
  const timer = setTimeout(() => {
    heartbeat = true
    controller.abort()
  }, 10)
  expect(await solving).toBeUndefined()
  clearTimeout(timer)
  expect(heartbeat).toBe(true)
  expect(Date.now() - started).toBeLessThan(1000)
  const challenge = {
    algorithm: "SHA-256",
    salt: "fast",
    challenge: createHash("sha256").update("fast0").digest("hex"),
    signature: "signature",
  }
  expect(await solveAltcha(challenge)).toBeDefined()
})
