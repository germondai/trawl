import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import { RequestValidationError } from "@trawl/tiers"

const PRIVATE_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const

const privateAddresses = new BlockList()
for (const [network, prefix] of PRIVATE_V4) privateAddresses.addSubnet(network, prefix, "ipv4")
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fe80::", 10],
  ["fc00::", 7],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  privateAddresses.addSubnet(network, prefix, "ipv6")

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]
  const family = isIP(normalized)
  // Numeric subnet checks also cover IPv4-mapped IPv6 after URL normalisation.
  return family === 0 || privateAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6")
}

export function parsePublicHttpUrl(rawUrl: string): { url: URL; hostname: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new RequestValidationError("url must be a valid absolute URL", 400)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RequestValidationError("url scheme must be http or https", 400)
  }
  if (url.username || url.password) {
    throw new RequestValidationError("url credentials are not allowed", 400)
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "")
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (isIP(hostname) && isPrivateIp(hostname))
  ) {
    throw new RequestValidationError("url must not target a private or local network", 400)
  }

  return { url, hostname }
}

export type HostLookup = (hostname: string) => Promise<{ address: string; family: number }[]>
const lookupAll: HostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true })

export async function resolvePublicHostname(
  hostname: string,
  lookupHost: HostLookup = lookupAll,
): Promise<{ address: string; family: number }[]> {
  let addresses: { address: string; family: number }[]
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookupHost(hostname)
  } catch {
    throw new RequestValidationError("url hostname could not be resolved", 400)
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new RequestValidationError("url must not target a private or local network", 400)
  }
  return addresses.map(({ address }) => ({ address, family: isIP(address) }))
}

export function createPublicUrlValidator(lookupHost: HostLookup = lookupAll): (rawUrl: string) => Promise<URL> {
  return async (rawUrl) => {
    const { url, hostname } = parsePublicHttpUrl(rawUrl)
    await resolvePublicHostname(hostname, lookupHost)
    return url
  }
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  return createPublicUrlValidator()(rawUrl)
}
