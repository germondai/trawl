import { domainToASCII } from "node:url"

export function dnsQuestion(host: string, kind: number) {
  const name = domainToASCII(host).toLowerCase().replace(/\.$/, "")
  const labels = name.split(".")
  if (!name || name.length > 253 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9_-]+$/.test(label)))
    throw new Error("Invalid DNS hostname")
  const packet = Buffer.alloc(12)
  packet.writeUInt16BE(crypto.getRandomValues(new Uint16Array(1))[0] ?? 0, 0)
  packet.writeUInt16BE(0x100, 2)
  packet.writeUInt16BE(1, 4)
  return Buffer.concat([
    packet,
    ...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0, 0, kind, 0, 1]),
  ])
}
export function dnsAnswer(packet: Buffer, question: Buffer) {
  const invalid = () => {
    throw new Error("Invalid DNS response")
  }
  if (packet.length < question.length || packet.length > 65535 || packet.readUInt16BE(0) !== question.readUInt16BE(0))
    return invalid()
  const flags = packet.readUInt16BE(2),
    code = flags & 15
  if (
    (flags & 0xfa00) !== 0x8000 ||
    packet.readUInt16BE(4) !== 1 ||
    !packet.subarray(12, question.length).equals(question.subarray(12))
  )
    return invalid()
  if (code !== 0 && code !== 3) throw new Error("DNS server could not resolve the query")
  let offset = question.length
  const count = packet.readUInt16BE(6)
  if (count > 128) return invalid()
  const Answer: { type: number; data: string; TTL: number }[] = []
  function skipName() {
    let length = 0
    while (offset < packet.length) {
      const size = packet.readUInt8(offset++)
      if (!size) return
      if ((size & 0xc0) === 0xc0) {
        const start = offset - 1
        if (offset >= packet.length) return invalid()
        const pointer = ((size & 63) << 8) | packet.readUInt8(offset++)
        if (pointer < 12 || pointer >= start) return invalid()
        return
      }

      length += size + 1
      if (size > 63 || length > 255 || offset + size > packet.length) return invalid()
      offset += size
    }
    return invalid()
  }
  for (let record = 0; record < count; record++) {
    skipName()
    if (offset + 10 > packet.length) return invalid()
    const type = packet.readUInt16BE(offset),
      cls = packet.readUInt16BE(offset + 2),
      TTL = packet.readUInt32BE(offset + 4),
      length = packet.readUInt16BE(offset + 8)
    offset += 10
    if (offset + length > packet.length) return invalid()
    if (cls === 1 && (type === 1 || type === 28)) {
      if (length !== (type === 1 ? 4 : 16)) return invalid()
      const bytes = packet.subarray(offset, offset + length)
      const data =
        type === 1
          ? [...bytes].join(".")
          : Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(":")
      Answer.push({ type, data, TTL })
    }
    offset += length
  }
  return { Status: code, Answer }
}
