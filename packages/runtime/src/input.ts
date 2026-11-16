import { createReadStream } from "node:fs"
import type { Readable } from "node:stream"
export async function readText(source: AsyncIterable<Uint8Array | string>, limit = 1048576): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const value of source) {
    const chunk = Buffer.from(value)
    size += chunk.length
    if (size > limit) throw new Error("Input exceeds 1 MiB")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}
export const readTextFile = (path: string) => readText(createReadStream(path))

export function readParentRequest(source: Readable, controller: AbortController): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    source.once("end", () => {
      const error = new Error("Parent disconnected")
      controller.abort(error)
      reject(error)
    })
    source.once("error", (error) => {
      controller.abort(error)
      reject(error)
    })
    const data = (value: Buffer | string) => {
      const chunk = Buffer.from(value)
      const newline = chunk.indexOf(10)
      const part = newline < 0 ? chunk : chunk.subarray(0, newline)
      bytes += part.length
      if (bytes > 1048576) {
        source.removeListener("data", data)
        reject(new Error("Input exceeds 1 MiB"))
        source.destroy()
        return
      }
      chunks.push(part)
      if (newline >= 0) {
        source.removeListener("data", data)
        resolve(Buffer.concat(chunks, bytes).toString("utf8"))
      }
    }
    source.on("data", data)
    source.resume()
  })
}
