import type { Cookie, SessionData } from "@trawl/types"
import { parseHTML } from "linkedom"
import { cookieMatchesUrl } from "./cookies"

function documentHash(html: string): string | undefined {
  // Bound parsing cost; uncertain or empty documents stay on the browser path.
  if (!html || html.length > 262_144) return
  try {
    const { document } = parseHTML(html)
    const body = document.body
    if (body?.textContent?.trim())
      return new Bun.CryptoHasher("sha256").update(document.documentElement.outerHTML.trim()).digest("hex")
  } catch {
    return
  }
}

export function httpReplayProof(url: string, html: string, cookies: Cookie[]): SessionData["httpReplay"] {
  if (hasClearance(cookies, new URL(url))) return
  const contentHash = documentHash(html)
  return contentHash ? { url: new URL(url).href, contentHash } : undefined
}

function hasClearance(cookies: Cookie[], target: URL): boolean {
  return cookies.some(
    (cookie) =>
      (cookie.name === "cf_clearance" || /^techaro\.lol-anubis(?:-auth)?(?:-[a-f0-9]{8})?$/.test(cookie.name)) &&
      cookie.value &&
      cookieMatchesUrl(cookie, target),
  )
}

// A request-local jar for a browser-verified origin. Cross-origin redirects and
// cookie attributes we cannot preserve return to the browser instead.
export class HttpSessionCookies {
  private cookies: Cookie[]
  private readonly domains: Set<string>

  constructor(
    private readonly origin: string,
    cookies: Cookie[],
    private readonly proof?: SessionData["httpReplay"],
  ) {
    this.cookies = cookies.map((cookie) => ({ ...cookie }))
    this.domains = new Set(cookies.map((cookie) => cookie.domain.replace(/^\./, "").toLowerCase()))
  }

  private static target(session: SessionData | undefined, url: string): URL | undefined {
    const target = new URL(url)
    if (session?.httpOrigin !== target.origin || !session.userAgent || session.cookies.length > 200) return
    return target
  }

  static fromClearance(session: SessionData | undefined, url: string): HttpSessionCookies | undefined {
    const target = HttpSessionCookies.target(session, url)
    if (!session || !target || !hasClearance(session.cookies, target)) return
    return new HttpSessionCookies(target.origin, session.cookies)
  }

  static from(session: SessionData | undefined, url: string): HttpSessionCookies | undefined {
    const verified = HttpSessionCookies.fromClearance(session, url)
    if (verified) return verified
    const target = HttpSessionCookies.target(session, url)
    if (!session || !target) return
    if (
      !session.cookies.some((cookie) => cookie.value && cookieMatchesUrl(cookie, target)) ||
      session.httpReplay?.url !== target.href ||
      !/^[a-f0-9]{64}$/.test(session.httpReplay.contentHash)
    )
      return
    return new HttpSessionCookies(target.origin, session.cookies, session.httpReplay)
  }

  matchesDocument(url: string, html: string): boolean {
    return !this.proof || (this.proof.url === new URL(url).href && documentHash(html) === this.proof.contentHash)
  }

  header(url: string): string {
    const target = new URL(url)
    if (target.origin !== this.origin) throw new Error("session-redirect-needs-browser")
    const header = this.cookies
      .filter((cookie) => cookieMatchesUrl(cookie, target))
      .sort((a, b) => b.path.length - a.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject header injection in cached values
    if (header.length > 16_384 || /[\r\n\x00]/.test(header)) throw new Error("session-cookies-need-browser")
    return header
  }

  update(headers: Headers, url: string): void {
    const target = new URL(url)
    for (const raw of headers.getSetCookie()) {
      try {
        if (raw.length > 4096) throw new Error()
        const parsed = Bun.Cookie.parse(raw)
        if (parsed.partitioned) throw new Error()
        const domain = parsed.domain?.replace(/^\./, "").toLowerCase() ?? target.hostname
        if (target.hostname !== domain && !target.hostname.endsWith(`.${domain}`)) continue
        // Parent domains are accepted only if the browser already validated them.
        if (domain !== target.hostname && !this.domains.has(domain)) throw new Error()
        const path = /;\s*path=\//i.test(raw)
          ? parsed.path
          : target.pathname.slice(0, target.pathname.lastIndexOf("/")) || "/"
        if (parsed.secure && target.protocol !== "https:") continue
        if (parsed.sameSite === "none" && !parsed.secure) continue
        if (parsed.name.startsWith("__Secure-") && !parsed.secure) continue
        if (parsed.name.startsWith("__Host-") && (!parsed.secure || parsed.domain || path !== "/")) continue
        const cookie: Cookie = {
          name: parsed.name,
          value: parsed.value,
          domain: parsed.domain ? `.${domain}` : domain,
          path,
          expires:
            parsed.maxAge !== undefined
              ? Math.max(0, Date.now() / 1000 + parsed.maxAge)
              : parsed.expires
                ? parsed.expires.getTime() / 1000
                : -1,
          httpOnly: parsed.httpOnly,
          secure: parsed.secure,
          sameSite: parsed.sameSite === "strict" ? "Strict" : parsed.sameSite === "none" ? "None" : "Lax",
        }
        this.cookies = this.cookies.filter(
          (old) =>
            old.name !== cookie.name ||
            old.domain.replace(/^\./, "").toLowerCase() !== domain ||
            old.path !== cookie.path,
        )
        if (cookie.expires === -1 || cookie.expires > Date.now() / 1000) this.cookies.push(cookie)
        if (this.cookies.length > 200) throw new Error()
      } catch {
        throw new Error("session-cookies-need-browser")
      }
    }
  }

  snapshot(): Cookie[] {
    return this.cookies.filter((cookie) => cookie.expires === -1 || cookie.expires > Date.now() / 1000)
  }
}
