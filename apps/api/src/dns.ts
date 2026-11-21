import { lookup } from "node:dns/promises"
import { connect } from "node:http2"
import { request } from "node:https"
import { createConnection, isIP, type LookupFunction } from "node:net"
import { dnsProviders } from "@trawl/config/catalog"
import { dnsAnswer, dnsQuestion } from "./dns-wire"
import type { HostLookup } from "./outbound-policy"

type DnsProvider = keyof typeof dnsProviders | "custom"
type Endpoint = { url: URL; bootstrap?: string } | { host: string; port: number }
export function dnsProvider(raw: string | undefined): "system" | DnsProvider {
  const value = raw?.trim() || "system"
  if (value !== "system" && value !== "custom" && !Object.hasOwn(dnsProviders, value))
    throw new Error("Unknown DNS_RESOLVER")
  return value as "system" | DnsProvider
}
export function dnsServers(raw: string): Endpoint[] {
  const values = raw
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (!values.length || values.length > 4 || raw.length > 8192) throw new Error("Custom DNS needs one to four servers")
  return values.map((value) => {
    if (value.startsWith("https://")) {
      const url = new URL(value)
      if (url.username || url.password || url.hash || url.search)
        throw new Error("Use a DNS HTTPS URL without credentials, query or fragment")
      return { url }
    }
    const match = value.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? (!isIP(value) ? value.match(/^([^:]+):(\d+)$/) : null)
    const host = match?.[1] ?? value,
      port = Number(match?.[2] ?? 53)
    if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Use a DNS server IP with an optional port, or an HTTPS URL")
    return { host, port }
  })
}
function exchangeHttp2(endpoint: Extract<Endpoint, { url: URL }>, packet: Buffer, timeout: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const address = endpoint.bootstrap
    const lookup: LookupFunction | undefined = address
      ? (_host, options, callback) =>
          options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)
      : undefined
    const session = connect(endpoint.url.origin, { lookup })
    const timer = setTimeout(() => session.destroy(new Error("DNS server timed out")), timeout)
    session.on("error", reject)
    session.on("close", () => {
      clearTimeout(timer)
      reject(new Error("DNS HTTP/2 connection closed"))
    })
    const stream = session.request({
      ":method": "POST",
      ":path": endpoint.url.pathname,
      accept: "application/dns-message",
      "content-type": "application/dns-message",
      "content-length": packet.length,
    })
    let valid = false,
      size = 0
    const chunks: Buffer[] = []
    stream.on("response", (headers) => {
      valid = headers[":status"] === 200 && String(headers["content-type"]).split(";")[0] === "application/dns-message"
    })
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 32768) session.destroy(new Error("DNS response exceeded its limit"))
      else chunks.push(chunk)
    })
    stream.on("error", (error) => {
      reject(error)
      session.destroy()
    })
    stream.on("end", () => {
      if (valid) resolve(Buffer.concat(chunks))
      else reject(new Error("DNS HTTPS server is unavailable"))
      session.close()
    })
    stream.end(packet)
  })
}
function exchange(endpoint: Endpoint, packet: Buffer, timeout: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if ("url" in endpoint) {
      const started = Date.now()
      const address = endpoint.bootstrap
      const bootstrapLookup: LookupFunction | undefined = address
        ? (_host, options, callback) =>
            options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)
        : undefined
      const req = request(
        endpoint.url,
        {
          method: "POST",
          agent: false,
          headers: {
            accept: "application/dns-message",
            "content-type": "application/dns-message",
            "content-length": packet.length,
          },
          lookup: bootstrapLookup,
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > 32768) req.destroy(new Error("DNS response exceeded its limit"))
            else chunks.push(chunk)
          })
          res.on("error", reject)
          res.on("end", () => {
            if (res.statusCode === 505) {
              void exchangeHttp2(endpoint, packet, Math.max(1, timeout - (Date.now() - started))).then(resolve, reject)
              return
            }
            if (res.statusCode === 200 && res.headers["content-type"]?.split(";")[0] === "application/dns-message")
              resolve(Buffer.concat(chunks))
            else reject(new Error("DNS HTTPS server is unavailable"))
          })
        },
      )
      const timer = setTimeout(() => req.destroy(new Error("DNS server timed out")), timeout)
      req.on("close", () => clearTimeout(timer))
      req.on("error", reject)
      req.end(packet)
    } else {
      const socket = createConnection(endpoint)
      let bytes = Buffer.alloc(0),
        expected = 0
      const timer = setTimeout(() => socket.destroy(new Error("DNS server timed out")), timeout)
      socket.on("connect", () => {
        const length = Buffer.alloc(2)
        length.writeUInt16BE(packet.length)
        socket.write(Buffer.concat([length, packet]))
      })
      socket.on("data", (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk])
        if (bytes.length >= 2) expected = bytes.readUInt16BE(0)
        if (bytes.length >= 2 && (expected < 12 || expected > 32768))
          socket.destroy(new Error("Invalid DNS frame size"))
        else if (expected && bytes.length >= expected + 2) {
          resolve(bytes.subarray(2, expected + 2))
          socket.destroy()
        }
      })
      socket.on("error", reject)
      socket.on("end", () => reject(new Error("DNS response interrupted")))
      socket.on("close", () => clearTimeout(timer))
    }
  })
}
async function query(provider: DnsProvider, hostname: string, kind: number, custom = "") {
  const preset = provider === "custom" ? undefined : dnsProviders[provider]
  const endpoints: Endpoint[] = preset
    ? [{ url: new URL(preset.url), bootstrap: preset.bootstrap }]
    : dnsServers(custom)
  const packet = dnsQuestion(hostname, kind),
    deadline = Date.now() + 5000
  let error: unknown
  for (const [index, endpoint] of endpoints.entries()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      return dnsAnswer(
        await exchange(endpoint, packet, Math.max(1, Math.floor(remaining / (endpoints.length - index)))),
        packet,
      )
    } catch (cause) {
      error = cause
    }
  }
  throw error ?? new Error("DNS server timed out")
}
export function createInstanceLookup(provider: DnsProvider, resolve = query, customServers = ""): HostLookup {
  if (provider === "custom") dnsServers(customServers)
  const cache = new Map<string, { until: number; addresses: { address: string; family: number }[] }>()
  return async (hostname) => {
    if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }]
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))
      return lookup(hostname, { all: true })
    const cached = cache.get(hostname)
    if (cached && cached.until > Date.now()) return cached.addresses
    const results = await Promise.all([
      resolve(provider, hostname, 1, customServers),
      resolve(provider, hostname, 28, customServers),
    ])
    let ttl = 300
    const addresses: { address: string; family: number }[] = []
    for (const result of results) {
      const response = result as { Status?: number; Answer?: { type: number; data: string; TTL: number }[] }
      if (response.Status !== 0 || !Array.isArray(response.Answer)) continue
      for (const record of response.Answer.slice(0, 64)) {
        if ((record.type === 1 && isIP(record.data) === 4) || (record.type === 28 && isIP(record.data) === 6)) {
          ttl = Math.min(ttl, Number.isFinite(record.TTL) ? Math.max(0, record.TTL) : 0)
          addresses.push({ address: record.data, family: isIP(record.data) })
        }
      }
    }
    if (!addresses.length) throw new Error("The configured DNS provider returned no addresses")
    if (cache.size >= 256) cache.delete(cache.keys().next().value ?? "")
    cache.set(hostname, { until: Date.now() + ttl * 1000, addresses })
    return addresses
  }
}
