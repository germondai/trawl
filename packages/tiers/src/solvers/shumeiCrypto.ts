import { createCipheriv } from "node:crypto"

function zeroPad(data: Buffer): Buffer {
  const rem = data.length % 8
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(8 - rem)])
}

export function desEncrypt(value: unknown, salt: string): string {
  const plain = typeof value === "string" ? value : JSON.stringify(value)
  if (plain === "") return ""
  const key = Buffer.from(salt, "utf8")
  if (key.length !== 8) throw new Error(`Shumei salt must be 8 bytes, got ${key.length}`)
  const cipher = createCipheriv("des-ecb", key, null)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(zeroPad(Buffer.from(plain, "utf8"))), cipher.final()])
  return encrypted.toString("base64")
}
