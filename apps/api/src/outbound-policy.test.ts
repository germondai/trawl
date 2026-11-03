import { describe, expect, test } from "bun:test"
import { assertPublicHttpUrl, createPublicUrlValidator } from "./outbound-policy"

describe("MCP outbound URL policy", () => {
  test("rejects a hostname that rebinds after an earlier public response", async () => {
    let lookups = 0
    const validate = createPublicUrlValidator(async () => [
      { address: ++lookups === 1 ? "1.1.1.1" : "127.0.0.1", family: 4 },
    ])
    await validate("http://rebind.example/first")
    await expect(validate("http://rebind.example/later")).rejects.toThrow("private or local network")
    expect(lookups).toBe(2)
  })
  for (const url of [
    "file:///etc/passwd",
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[0:0:0:0:0:ffff:7f00:1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[2001:db8::1]/",
    "http://user:password@example.com/",
  ]) {
    test(`rejects ${url}`, async () => {
      await expect(assertPublicHttpUrl(url)).rejects.toThrow()
    })
  }

  test("accepts a public literal address", async () => {
    expect((await assertPublicHttpUrl("https://1.1.1.1/path")).hostname).toBe("1.1.1.1")
  })
})
