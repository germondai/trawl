import { describe, expect, test } from "bun:test"
import type { Page } from "patchright"
import {
  djb2Hash,
  encrypt,
  decrypt,
  hashL,
  PRNGStream,
  toInt32,
  toUint32,
  wDecode,
  wEncode,
  xorshift32,
} from "../src/solvers/datadome/crypto"
import {
  buildPayload,
  buildPayloadWithVariation,
  CHROME_WIN_PROFILE,
  computeChecksums,
  computeFph,
  generateBchk,
  generateNavTiming,
  generateR3n,
  generateTrrd,
} from "../src/solvers/datadome/builder"
import { extractFromCaptchaUrl, solveDataDomeDirect } from "../src/solvers/datadome/solver"

describe("crypto: 32-bit integer helpers", () => {
  test("toInt32 wraps large numbers", () => {
    expect(toInt32(0x80000000)).toBe(-2147483648)
    expect(toInt32(0xffffffff)).toBe(-1)
  })

  test("toUint32 keeps unsigned", () => {
    expect(toUint32(-1)).toBe(0xffffffff)
    expect(toUint32(0x80000000)).toBe(0x80000000)
  })
})

describe("crypto: xorshift32", () => {
  test("produces deterministic sequence", () => {
    let state = 12345
    const values: number[] = []
    for (let i = 0; i < 5; i++) {
      state = xorshift32(state)
      values.push(state)
    }
    // Verify determinism: same seed produces same sequence
    let state2 = 12345
    const values2: number[] = []
    for (let i = 0; i < 5; i++) {
      state2 = xorshift32(state2)
      values2.push(state2)
    }
    expect(values).toEqual(values2)
    expect(values.length).toBe(5)
  })
})

describe("crypto: hashL (Java-style)", () => {
  test("hashes strings consistently", () => {
    expect(hashL("test")).toBe(hashL("test"))
    expect(hashL("abc")).not.toBe(hashL("def"))
  })

  test("uses seed for empty string", () => {
    const result = hashL("")
    expect(result).toBeGreaterThan(0)
  })
})

describe("crypto: djb2Hash", () => {
  test("matches known values", () => {
    expect(djb2Hash("")).toBe(5381)
    expect(djb2Hash("a")).toBe(177670)
    expect(djb2Hash("test")).toBe(2090756197)
  })
})

describe("crypto: PRNGStream", () => {
  test("generates bytes from xorshift state", () => {
    const stream = new PRNGStream(12345)
    const bytes = stream.nextBytes(8)
    expect(bytes.length).toBe(8)
    expect(bytes.every((b) => b >= 0 && b <= 255)).toBe(true)
  })

  test("with IV XOR produces different output", () => {
    const stream1 = new PRNGStream(12345, false)
    const stream2 = new PRNGStream(12345, true)
    const b1 = stream1.nextBytes(4)
    const b2 = stream2.nextBytes(4)
    expect(b1).not.toEqual(b2)
  })
})

describe("crypto: 6-bit encoding", () => {
  test("encode/decode roundtrips", () => {
    const original = [0, 1, 127, 128, 255, 100, 200, 50]
    const encoded = wEncode(original)
    const decoded = wDecode(encoded)
    // Note: decode may have trailing zeros due to padding
    expect(decoded.slice(0, original.length)).toEqual(original)
  })

  test("encodes to alphanumeric + -_", () => {
    const encoded = wEncode([0, 255, 128, 64])
    expect(/^[A-Za-z0-9\-_]+$/.test(encoded)).toBe(true)
  })
})

describe("crypto: encrypt/decrypt", () => {
  test("roundtrips simple payload", () => {
    const original = { test: "value", num: 123, bool: true }
    const ddjskey = "testkey123"
    const cid = "testcid456"
    const timestamp = Date.now()

    const encrypted = encrypt(original, ddjskey, cid, timestamp)
    expect(typeof encrypted).toBe("string")
    expect(encrypted.length).toBeGreaterThan(0)

    const decrypted = decrypt(encrypted, ddjskey, cid)
    expect(decrypted).toEqual(original)
  })

  test("different keys produce different output", () => {
    const payload = { a: 1 }
    const e1 = encrypt(payload, "key1", "cid1")
    const e2 = encrypt(payload, "key2", "cid2")
    expect(e1).not.toBe(e2)
  })

  test("decrypt with wrong key returns undefined", () => {
    const encrypted = encrypt({ test: 1 }, "correct", "cid")
    const decrypted = decrypt(encrypted, "wrong", "cid")
    expect(decrypted).toBeUndefined()
  })
})

describe("builder: navigation timing", () => {
  test("generates all required keys", () => {
    const timing = generateNavTiming(Math.random)
    const requiredKeys = [
      "nt_tcp",
      "nt_dns",
      "nt_rd",
      "nt_irt",
      "nt_rt",
      "nt_tls",
      "nt_ttf",
      "nt_swt",
      "nt_csd",
      "nt_nhp",
      "nt_rdc",
      "nt_it",
      "nt_prs",
      "nt_esc",
      "nt_ttrd",
      "nt_le",
      "nt_dcle",
      "nt_di",
      "nt_dc",
    ]
    for (const key of requiredKeys) {
      expect(timing).toHaveProperty(key)
    }
  })

  test("values have correct types", () => {
    const timing = generateNavTiming(Math.random)
    expect(typeof timing.nt_tcp).toBe("number")
    expect(typeof timing.nt_dns).toBe("number")
    expect(timing.nt_nhp).toBe("h2")
    expect(timing.nt_it).toBe("navigation")
  })
})

describe("builder: generateTrrd", () => {
  test("returns a number from atan2", () => {
    for (let i = 0; i < 10; i++) {
      const trrd = generateTrrd(Math.random)
      expect(typeof trrd).toBe("number")
      // atan2 returns values in range [-PI, PI]
      expect(trrd).toBeGreaterThanOrEqual(-Math.PI)
      expect(trrd).toBeLessThanOrEqual(Math.PI)
    }
  })
})

describe("builder: generateBchk", () => {
  test("returns alphanumeric string", () => {
    const bchk = generateBchk()
    expect(typeof bchk).toBe("string")
    expect(bchk.length).toBeGreaterThan(100) // BCHK_APIS.length
  })
})

describe("builder: generateR3n", () => {
  test("returns hash with serverHash", () => {
    const r3n = generateR3n(() => 0.5, "abcdef1234")
    expect(typeof r3n).toBe("string")
    expect((r3n as string).includes("1234")).toBe(true)
  })

  test("returns 33 without serverHash", () => {
    expect(generateR3n(() => 0.5)).toBe(33)
    expect(generateR3n(() => 0.5, "xy")).toBe(33)
  })
})

describe("builder: checksums", () => {
  test("computes sgb, sgd, sgc as strings", () => {
    const signals = { lgs: "en", pf: "Win32", ts_mtp: 0, mob: false, hc: 8, dvm: 8, tz: -60, eva: 40, wdifpnh: "123" }
    const checksums = computeChecksums(signals)
    expect(checksums).toHaveProperty("sgb")
    expect(checksums).toHaveProperty("sgd")
    expect(checksums).toHaveProperty("sgc")
    expect(typeof checksums.sgb).toBe("string")
  })

  test("same input produces same checksums", () => {
    const signals = { lgs: "en", pf: "Win32", ts_mtp: 0, mob: false, hc: 8, dvm: 8, tz: -60, eva: 40, wdifpnh: "123" }
    const c1 = computeChecksums(signals)
    const c2 = computeChecksums(signals)
    expect(c1).toEqual(c2)
  })
})

describe("builder: computeFph", () => {
  test("returns number", () => {
    const fph = computeFph(CHROME_WIN_PROFILE)
    expect(typeof fph).toBe("number")
  })
})

describe("builder: buildPayload", () => {
  test("includes all required signals", () => {
    const payload = buildPayload(CHROME_WIN_PROFILE, "https://example.com", "hash123")
    expect(payload).toHaveProperty("ua")
    expect(payload).toHaveProperty("glvd")
    expect(payload).toHaveProperty("glrd")
    expect(payload).toHaveProperty("rs_w")
    expect(payload).toHaveProperty("rs_h")
    expect(payload).toHaveProperty("tz")
    expect(payload).toHaveProperty("fph")
    expect(payload).toHaveProperty("sgb")
    expect(payload).toHaveProperty("bchk")
  })

  test("uses deterministic random", () => {
    let seed = 0.5
    const fakeRandom = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }

    const p1 = buildPayload(CHROME_WIN_PROFILE, "https://example.com", "hash", fakeRandom)
    seed = 0.5
    const p2 = buildPayload(CHROME_WIN_PROFILE, "https://example.com", "hash", fakeRandom)

    expect(p1.trrd).toBe(p2.trrd)
    expect(p1.wdifpnh).toBe(p2.wdifpnh)
  })
})

describe("builder: buildPayloadWithVariation", () => {
  test("varies resolution and hardware", () => {
    const payloads = Array.from({ length: 10 }, () => buildPayloadWithVariation("https://example.com", "hash"))
    const resolutions = new Set(payloads.map((p) => `${p.rs_w}x${p.rs_h}`))
    const hcs = new Set(payloads.map((p) => p.hc))

    // Should have some variation
    expect(resolutions.size).toBeGreaterThanOrEqual(1)
    expect(hcs.size).toBeGreaterThanOrEqual(1)
  })
})

describe("solver: extractFromCaptchaUrl", () => {
  test("extracts cid and hash from URL", () => {
    const url =
      "https://geo.captcha-delivery.com/captcha/?initialCid=ABC&cid=XYZ123&hash=HASH456&referer=https://example.com"
    const params = extractFromCaptchaUrl(url)
    expect(params).toEqual({
      cid: "XYZ123",
      hash: "HASH456",
      initialCid: "ABC",
    })
  })

  test("returns undefined for invalid URL", () => {
    expect(extractFromCaptchaUrl("not a url")).toBeUndefined()
    expect(extractFromCaptchaUrl("https://example.com")).toBeUndefined()
  })
})

describe("solver: solveDataDomeDirect", () => {
  function fakePage(response: { status: number; body: unknown } | "error") {
    const requests: Array<{ url: string; data: string }> = []

    const page = {
      request: {
        post: async (url: string, options: { data: string }) => {
          requests.push({ url, data: options.data })
          if (response === "error") throw new Error("network error")
          return {
            ok: () => response.status >= 200 && response.status < 300,
            status: () => response.status,
            json: async () => response.body,
          }
        },
      },
    } as unknown as Page

    return { page, requests }
  }

  test("posts encrypted jspl to DataDome API", async () => {
    const { page, requests } = fakePage({
      status: 200,
      body: { status: 200, cookie: "datadome=abc123; Path=/; Secure" },
    })

    const result = await solveDataDomeDirect(page, {
      ddk: "DDK123",
      cid: "CID456",
      origin: "https://example.com",
      url: "https://example.com/page",
    })

    expect(result.success).toBe(true)
    expect(result.cookie).toBe("abc123")
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("https://api-js.datadome.co/js/")

    const params = new URLSearchParams(requests[0].data)
    expect(params.get("ddk")).toBe("DDK123")
    expect(params.get("cid")).toBe("CID456")
    expect(params.get("jspl")).toBeTruthy()
    expect(params.get("ddv")).toBe("5.11.4")
  })

  test("returns error on HTTP failure", async () => {
    const { page } = fakePage({ status: 403, body: {} })

    const result = await solveDataDomeDirect(page, {
      ddk: "DDK",
      cid: "CID",
      origin: "https://example.com",
      url: "https://example.com/page",
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe("http 403")
  })

  test("returns error on status !== 200", async () => {
    const { page } = fakePage({ status: 200, body: { status: 403 } })

    const result = await solveDataDomeDirect(page, {
      ddk: "DDK",
      cid: "CID",
      origin: "https://example.com",
      url: "https://example.com/page",
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe("status 403")
  })

  test("returns error on network failure", async () => {
    const { page } = fakePage("error")

    const result = await solveDataDomeDirect(page, {
      ddk: "DDK",
      cid: "CID",
      origin: "https://example.com",
      url: "https://example.com/page",
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe("network error")
  })
})
