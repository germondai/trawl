const localHostnames = new Set(["127.0.0.1", "[::1]", "localhost", "host.docker.internal", "host.orb.internal"])

/** Managed loopback instances reject browser cross-origin requests and DNS rebinding. */
export function allowLocalRequest(request: Request, host: string): boolean {
  try {
    const url = new URL(request.url)
    const origin = request.headers.get("origin")
    if (request.headers.get("sec-fetch-site") === "cross-site") return false
    if (origin !== null && origin !== url.origin) return false
    if (["127.0.0.1", "::1", "localhost"].includes(host)) {
      const authority = new URL(`http://${request.headers.get("host") || url.host}`)
      if (authority.username || authority.password || !localHostnames.has(authority.hostname)) return false
    }
    return true
  } catch {
    return false
  }
}
