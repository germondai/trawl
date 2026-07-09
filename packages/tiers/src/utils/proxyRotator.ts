// Proxy pool with sticky-per-domain routing, round-robin fallback, and failure cooldown.
// Sourced from a user-supplied comma-separated list or line-delimited file — TRAWL never
// fetches or trusts any third-party proxy list.

import { readFileSync } from "node:fs"
import type { ProxyEndpointInput } from "@trawl/types"

const COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes — matches the plan's "time-boxed cooldown"

// Normalizes the per-request `proxy` field at the API boundary into a single URL string.
// Prowlarr's Cardigann flow serializes proxy config as an object {url, username, password};
// other callers send a plain URL string. Playwright's `newContext({proxy})` expects
// `server` to be a string — passing the object through untyped crashes with
// `proxy.server: expected string, got object` (issue #12).
//
// Returns undefined for null/undefined/empty/non-string-non-object inputs.
// Credentials (if present in the object form) are URL-encoded and embedded into the URL
// so downstream code keeps treating proxy as a single string.
export function normalizeProxy(input: ProxyEndpointInput | null | undefined): string | undefined {
  if (input == null) return undefined
  if (typeof input === "string") {
    const trimmed = input.trim()
    return trimmed ? trimmed : undefined
  }
  if (typeof input === "object") {
    const server =
      typeof input.url === "string" ? input.url : typeof input.server === "string" ? input.server : undefined
    if (!server) return undefined
    const user = typeof input.username === "string" && input.username.length > 0 ? input.username : undefined
    const pass = typeof input.password === "string" && input.password.length > 0 ? input.password : undefined
    if (!user && !pass) return server
    const schemeMatch = server.match(/^([a-z][a-z0-9+\-.]*:\/\/)(.*)$/i)
    if (!schemeMatch) return server
    const creds = `${encodeURIComponent(user ?? "")}:${encodeURIComponent(pass ?? "")}`
    return `${schemeMatch[1]}${creds}@${schemeMatch[2]}`
  }
  return undefined
}

interface ProxyState {
  url: string
  badUntil: number
}

export class ProxyPool {
  private proxies: ProxyState[]
  private cursor = 0
  private stickyByDomain = new Map<string, string>()

  constructor(urls: string[]) {
    this.proxies = urls.filter(Boolean).map((url) => ({ url, badUntil: 0 }))
  }

  // Builds a pool from a comma-separated env var and/or a line-delimited file (one proxy
  // per line, '#' comments allowed). A single URL still works — it's just a 1-element list.
  // Returns null if neither source yields any proxies, so callers can treat "no proxy
  // configured" the same way they did with the old single-string PROXY_URL/RESIDENTIAL_PROXY_URL.
  static fromEnv(urlListEnv?: string, fileEnv?: string): ProxyPool | null {
    const urls: string[] = []
    if (urlListEnv) {
      urls.push(
        ...urlListEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    }
    if (fileEnv) {
      try {
        const lines = readFileSync(fileEnv, "utf-8")
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#"))
        urls.push(...lines)
      } catch (err) {
        console.warn(`[proxy] failed to read proxy list file ${fileEnv}:`, err instanceof Error ? err.message : err)
      }
    }
    return urls.length > 0 ? new ProxyPool(urls) : null
  }

  get size(): number {
    return this.proxies.length
  }

  private available(): ProxyState[] {
    const now = Date.now()
    return this.proxies.filter((p) => p.badUntil <= now)
  }

  // Sticky-per-domain: reuse the same proxy for repeat requests to a domain (consistency
  // helps avoid re-triggering challenges); falls back to round-robin across available
  // proxies for new domains or once the sticky proxy has been marked bad.
  next(domain?: string): string | null {
    const available = this.available()
    if (available.length === 0) return null

    if (domain) {
      const sticky = this.stickyByDomain.get(domain)
      if (sticky && available.some((p) => p.url === sticky)) return sticky
    }

    const proxy = available[this.cursor % available.length]
    this.cursor = (this.cursor + 1) % available.length
    if (domain) this.stickyByDomain.set(domain, proxy.url)
    return proxy.url
  }

  random(): string | null {
    const available = this.available()
    if (available.length === 0) return null
    return available[Math.floor(Math.random() * available.length)].url
  }

  // Puts a proxy in cooldown after a tier reports "blocked"/"ip-blocked" for it — skipped
  // by next()/random() until the cooldown expires. Also drops any sticky-domain mapping
  // pointing at it so the next call for that domain picks a different proxy.
  markBad(url: string): void {
    const entry = this.proxies.find((p) => p.url === url)
    if (entry) entry.badUntil = Date.now() + COOLDOWN_MS
    for (const [domain, sticky] of this.stickyByDomain) {
      if (sticky === url) this.stickyByDomain.delete(domain)
    }
  }
}
