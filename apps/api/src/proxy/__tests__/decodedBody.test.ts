import { expect, test } from "bun:test"
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib"
import { decodedBody } from "../decodedBody"

test("optional proxy inspection decodes supported representations within a fixed output budget", () => {
  const body = Buffer.from("Owned fixture text. ".repeat(100))
  for (const [encoding, compress] of [
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const) {
    const wire = compress(body)
    expect(decodedBody(wire, encoding, body.byteLength)?.equals(body)).toBe(true)
    expect(decodedBody(wire, encoding, 128)).toBeUndefined()
    expect(wire.equals(compress(body))).toBe(true)
  }
  expect(decodedBody(body, undefined, body.byteLength)).toBe(body)
  expect(decodedBody(body, undefined, 128)).toBeUndefined()
  expect(decodedBody(body, "gzip")).toBeUndefined()
  expect(decodedBody(body, "gzip, br")).toBeUndefined()
})
