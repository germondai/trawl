import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib"

/** Optional inspection/capture must not expand a buffered representation without a byte limit. */
export function decodedBody(body: Buffer, contentEncoding?: string, maxBytes = 8 * 1024 * 1024): Buffer | undefined {
  const encoding = contentEncoding?.trim().toLowerCase()
  try {
    const options = { maxOutputLength: maxBytes }
    if (encoding === "gzip" || encoding === "x-gzip") return gunzipSync(body, options)
    if (encoding === "deflate") return inflateSync(body, options)
    if (encoding === "br") return brotliDecompressSync(body, options)
    if ((!encoding || encoding === "identity") && body.byteLength <= maxBytes) return body
  } catch {
    // Malformed or oversized representations are still forwarded in their original form.
  }
}
