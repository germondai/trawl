import { expect, test } from "bun:test"
import { once } from "node:events"
import { createServer } from "node:net"
import { createInstanceLookup, dnsServers } from "./dns"
import { dnsAnswer, dnsQuestion } from "./dns-wire"

function response(question: Buffer, nx = false) {
  const answer = Buffer.from(question)
  answer.writeUInt16BE(nx ? 0x8183 : 0x8180, 2)
  if (!nx && question.readUInt16BE(question.length - 4) === 1) {
    answer.writeUInt16BE(1, 6)
    return Buffer.concat([answer, Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1])])
  }
  return answer
}
test("wire DNS validates response identity, question, compressed names and record lengths", () => {
  const question = dnsQuestion("owned.fixture", 1),
    answer = response(question)
  expect(dnsAnswer(answer, question).Answer[0]?.data).toBe("127.0.0.1")
  for (let end = 0; end < answer.length; end++) expect(() => dnsAnswer(answer.subarray(0, end), question)).toThrow()
  for (const offset of [0, 2, 5, 13]) {
    const malformed = Buffer.from(answer)
    malformed[offset] = (malformed[offset] ?? 0) ^ 0x40
    expect(() => dnsAnswer(malformed, question)).toThrow()
  }
  const malformed = Buffer.from(answer)
  malformed[question.length] = 0xff
  malformed[question.length + 1] = 0xff
  expect(() => dnsAnswer(malformed, question)).toThrow()
  const loop = Buffer.from(answer)
  loop.writeUInt16BE(0xc000 | question.length, question.length)
  expect(() => dnsAnswer(loop, question)).toThrow()
  expect(() => dnsQuestion("bad..name", 1)).toThrow()
})
test("custom DNS accepts explicit IP servers and HTTPS endpoints, and rejects ambiguous or credentialed values", () => {
  expect(dnsServers("1.0.0.1, [::1]:5353, https://dns.example/dns-query")).toHaveLength(3)
  for (const raw of [
    "",
    "host:53",
    "1.1.1.1:0",
    "http://dns.example/",
    "https://user:pass@dns.example/",
    "https://dns.example/#fragment",
    Array(5).fill("1.1.1.1").join(","),
  ])
    expect(() => dnsServers(raw)).toThrow()
})
test("custom TCP DNS resolves through the configured server and does not evade a valid filtered answer", async () => {
  let filtered = false,
    requests = 0
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)])
      if (bytes.length < 2 || bytes.length < bytes.readUInt16BE(0) + 2) return
      requests++
      const packet = response(bytes.subarray(2), filtered),
        length = Buffer.alloc(2)
      length.writeUInt16BE(packet.length)
      socket.end(Buffer.concat([length, packet]))
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture has no port")
  try {
    const lookup = createInstanceLookup("custom", undefined, `127.0.0.1:${address.port}`)
    expect(await lookup("owned.fixture")).toEqual([{ address: "127.0.0.1", family: 4 }])
    filtered = true
    const filteredLookup = createInstanceLookup("custom", undefined, `127.0.0.1:${address.port}, 127.0.0.1:1`)
    await expect(filteredLookup("filtered.fixture")).rejects.toThrow("returned no addresses")
    expect(requests).toBe(4)
  } finally {
    server.close()
  }
})

test("custom DNS reaches later servers within its shared deadline", async () => {
  const sockets = new Set<import("node:net").Socket>()
  const silent = createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => sockets.delete(socket))
  })
  const working = createServer((socket) => {
    socket.on("data", (bytes) => {
      const packet = response(Buffer.from(bytes).subarray(2)),
        length = Buffer.alloc(2)
      length.writeUInt16BE(packet.length)
      socket.end(Buffer.concat([length, packet]))
    })
  })
  silent.listen(0, "127.0.0.1")
  working.listen(0, "127.0.0.1")
  await Promise.all([once(silent, "listening"), once(working, "listening")])
  const a = silent.address(),
    b = working.address()
  if (!a || !b || typeof a === "string" || typeof b === "string") throw new Error("No fixture port")
  try {
    const lookup = createInstanceLookup(
      "custom",
      undefined,
      `127.0.0.1:${a.port},127.0.0.1:${a.port},127.0.0.1:${b.port},127.0.0.1:1`,
    )
    expect(await lookup("owned.fixture")).toEqual([{ address: "127.0.0.1", family: 4 }])
  } finally {
    for (const socket of sockets) socket.destroy()
    silent.close()
    working.close()
  }
})
