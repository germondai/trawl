const GOOGLE_SEARCH_HOSTS = new Set(["google.com", "www.google.com", "ipv4.google.com", "ipv6.google.com"])

export function isGoogleSorryUrl(url: string): boolean {
  try {
    const target = new URL(url)
    return (
      (target.protocol === "https:" || target.protocol === "http:") &&
      target.port === "" &&
      target.username === "" &&
      target.password === "" &&
      GOOGLE_SEARCH_HOSTS.has(target.hostname.replace(/\.$/, "")) &&
      (target.pathname === "/sorry" || target.pathname.startsWith("/sorry/"))
    )
  } catch {
    return false
  }
}
