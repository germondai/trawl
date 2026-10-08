import { describe, expect, test } from "bun:test"
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib"
import { runTier1 } from "../src/tiers/1"

type EncodingCase = {
  encoding: string
  encode: (body: Buffer<ArrayBuffer>) => Buffer<ArrayBuffer>
}

const encodingCases: EncodingCase[] = [
  { encoding: "gzip", encode: gzipSync },
  { encoding: "deflate", encode: deflateSync },
  { encoding: "br", encode: brotliCompressSync },
  { encoding: "zstd", encode: zstdCompressSync },
  {
    encoding: "br, gzip",
    encode: (body) => gzipSync(brotliCompressSync(body)),
  },
]

describe("runTier1 — encoded response bodies", () => {
  test.each(encodingCases)(
    "preserves $encoding representation bytes while decoding html",
    async ({ encoding, encode }) => {
      const text = `<html><body>encoded with ${encoding}</body></html>`
      const encoded = encode(Buffer.from(text))
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response(new Uint8Array(encoded), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-encoding": encoding,
              "content-length": String(encoded.length),
              etag: '"encoded-v1"',
            },
          })
        },
      })

      try {
        const result = await runTier1(`http://127.0.0.1:${server.port}/`)

        expect(result.status).toBe("success")
        expect(Buffer.from(result.body ?? [])).toEqual(encoded)
        expect(result.html).toBe(text)
        expect(result.responseHeaders?.["content-encoding"]).toBe(encoding)
        expect(result.responseHeaders?.["content-length"]).toBe(String(encoded.length))
        expect(result.responseHeaders?.etag).toBe('"encoded-v1"')
      } finally {
        server.stop(true)
      }
    },
  )

  test("detects a challenge through a compressed inspection copy", async () => {
    const challenge = "<html><head><title>Just a moment...</title></head><body></body></html>"
    const encoded = gzipSync(Buffer.from(challenge))
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new Uint8Array(encoded), {
          status: 403,
          headers: {
            "content-type": "text/html",
            "content-encoding": "gzip",
            "content-length": String(encoded.length),
          },
        })
      },
    })

    try {
      const result = await runTier1(`http://127.0.0.1:${server.port}/`)

      expect(result.status).toBe("needs-js")
      expect(result.challenge).toBe("cloudflare-interstitial")
      expect(Buffer.from(result.body ?? [])).toEqual(encoded)
    } finally {
      server.stop(true)
    }
  })

  test("keeps identity range metadata and partial bytes intact", async () => {
    const partial = Buffer.from("456789")
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(partial, {
          status: 206,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(partial.length),
            "content-range": "bytes 4-9/16",
            "accept-ranges": "bytes",
            etag: '"identity-v1"',
          },
        })
      },
    })

    try {
      const result = await runTier1(`http://127.0.0.1:${server.port}/`, { Range: "bytes=4-9" })

      expect(result.status).toBe("success")
      expect(result.statusCode).toBe(206)
      expect(Buffer.from(result.body ?? [])).toEqual(partial)
      expect(result.responseHeaders?.["content-range"]).toBe("bytes 4-9/16")
      expect(result.responseHeaders?.["accept-ranges"]).toBe("bytes")
      expect(result.responseHeaders?.etag).toBe('"identity-v1"')
    } finally {
      server.stop(true)
    }
  })

  test("falls back to the original bytes for malformed encoded content", async () => {
    const malformed = Buffer.from("not actually gzip")
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(malformed, {
          headers: {
            "content-type": "application/octet-stream",
            "content-encoding": "gzip",
            "content-length": String(malformed.length),
          },
        })
      },
    })

    try {
      const result = await runTier1(`http://127.0.0.1:${server.port}/`)

      expect(result.status).toBe("success")
      expect(Buffer.from(result.body ?? [])).toEqual(malformed)
      expect(result.responseHeaders?.["content-encoding"]).toBe("gzip")
    } finally {
      server.stop(true)
    }
  })
})

describe("runTier1 raw text documents", () => {
  test.each([
    {
      name: "whitespace",
      type: "text/plain; charset=utf-8",
      body: Buffer.from("  alpha\r\n\r\n\r\nbeta  \n"),
      text: "  alpha\r\n\r\n\r\nbeta  \n",
    },
    { name: "empty", type: "text/plain", body: Buffer.from(""), text: "" },
    { name: "charset", type: "text/plain; charset=iso-8859-1", body: Buffer.from([99, 97, 102, 233]), text: "café" },
  ])("preserves $name through a compressed response", async ({ type, body, text }) => {
    const encoded = gzipSync(body)
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(new Uint8Array(encoded), { headers: { "content-type": type, "content-encoding": "gzip" } }),
    })
    try {
      const result = await runTier1(`http://127.0.0.1:${server.port}/`)
      expect(result.status).toBe("success")
      expect(result.html).toBe(text)
      expect(Buffer.from(result.body ?? [])).toEqual(encoded)
      expect(result.responseHeaders?.["content-encoding"]).toBe("gzip")
    } finally {
      server.stop(true)
    }
  })
})
