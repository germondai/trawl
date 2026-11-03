import { lookup } from "node:dns/promises"
import type net from "node:net"
import { BlockList, isIP } from "node:net"
import { hostname, networkInterfaces } from "node:os"

interface LocalProxy {
  server: net.Server
  configuredPort: number
  ca: string
}

const active = new Set<LocalProxy>()

export const registerLocalProxy = (proxy: LocalProxy): (() => void) => {
  active.add(proxy)
  return () => active.delete(proxy)
}

const localAddresses = (): Set<string> => {
  const addresses = new Set(["127.0.0.1", "::1"])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(entry.address.split("%")[0] ?? entry.address)
  }
  return addresses
}

const resolvesLocally = async (host: string): Promise<boolean> => {
  if (host === "localhost" || host === hostname()) return true
  try {
    const resolved = await lookup(host, { all: true })
    const addresses = localAddresses()
    return resolved.length > 0 && resolved.every(({ address }) => addresses.has(address.split("%")[0] ?? address))
  } catch {
    return false
  }
}

/** Return the CA only when the URL targets a currently listening local MITM proxy. */
export const localProxyCa = async (proxyUrl: string): Promise<string | undefined> => {
  let url: URL
  try {
    url = new URL(proxyUrl)
  } catch {
    return
  }
  if (url.protocol !== "http:") return
  const matching = matchingProxies(url)
  if (matching.length === 0 || !(await resolvesLocally(url.hostname))) return
  return matching[0]?.ca
}

function matchingProxies(url: URL): LocalProxy[] {
  const port = Number(url.port || "80")
  const matching: LocalProxy[] = []
  for (const proxy of active) {
    if (!proxy.server.listening) continue
    const address = proxy.server.address()
    const listeningPort = address && typeof address !== "string" ? address.port : proxy.configuredPort
    if (port === listeningPort) matching.push(proxy)
  }
  return matching
}

/** Rejection is deliberately broader than CA trust, including wildcard loopback aliases. */
export async function isLocalMitmProxy(proxyUrl: string): Promise<boolean> {
  const url = new URL(proxyUrl)
  if (url.protocol !== "http:" || matchingProxies(url).length === 0) return false
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const locals = new BlockList()
  locals.addSubnet("127.0.0.0", 8, "ipv4")
  locals.addSubnet("0.0.0.0", 8, "ipv4")
  locals.addAddress("::", "ipv6")
  for (const address of localAddresses()) locals.addAddress(address, isIP(address) === 6 ? "ipv6" : "ipv4")
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
    return addresses.some(({ address }) => locals.check(address, isIP(address) === 6 ? "ipv6" : "ipv4"))
  } catch {
    return false
  }
}
