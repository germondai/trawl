import type { RequestField } from "./request-fields"

export interface RequestFile {
  name: string
  type: string
  data: string
}
export const requestFileLimit = 128 * 1024
export function bytesBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
  return btoa(parts.join(""))
}
export function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  if (
    value.length > Math.ceil(requestFileLimit / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("Invalid or oversized binary body (128 KiB maximum)")
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
  if (bytes.length > requestFileLimit || bytesBase64(bytes) !== value) throw new Error("Invalid binary body")
  return bytes
}
export async function readRequestFile(file: File): Promise<RequestFile> {
  if (file.size > requestFileLimit) throw new Error("Choose a file of at most 128 KiB")
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    data: bytesBase64(new Uint8Array(await file.arrayBuffer())),
  }
}
export function multipartBody(text: string, fields: RequestField[]) {
  const boundary = `trawl-${crypto.randomUUID()}`
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const encode = new TextEncoder()
  const name = (value: string) =>
    value.replace(/[\r\n"\\]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
  for (const [key, value] of new URLSearchParams(text.split("\n").filter(Boolean).join("&"))) {
    if (/[\r\n\0]/.test(key)) throw new Error("Form names must be single-line values")
    chunks.push(
      encode.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name(key)}"\r\n\r\n${value}\r\n`),
    )
  }
  let fileBytes = 0
  const files = fields.filter((row) => row.enabled && row.file)
  for (const row of files) {
    const file = row.file
    if (!file) continue
    if (!row.key || !file.name || !/^[\w.+-]+\/[\w.+-]+$/.test(file.type))
      throw new Error("Choose a file, field name and valid file content type")
    const bytes = base64Bytes(file.data)
    fileBytes += bytes.length
    if (fileBytes > requestFileLimit) throw new Error("Files in one request must total at most 128 KiB")
    chunks.push(
      encode.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name(row.key)}"; filename="${name(file.name)}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      bytes,
      encode.encode("\r\n"),
    )
  }
  chunks.push(encode.encode(`--${boundary}--\r\n`))
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  if (length > 256 * 1024) throw new Error("Multipart body exceeds 256 KiB")
  const data = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return {
    body: files.length ? bytesBase64(data) : new TextDecoder().decode(data),
    bodyEncoding: files.length ? ("base64" as const) : undefined,
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}
