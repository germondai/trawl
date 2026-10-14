const PROXY_TRANSPORT_FAILURE =
  /proxy|tunnel|connect(?:ion)? (?:refused|reset|closed|failed|timed out)|tls|ssl|certificate|unexpected eof|socket hang up|ECONN(?:REFUSED|RESET)|EPROTO|NS_ERROR_[A-Z_]*PROXY/i

export function hasProxyStatusError(headers: Record<string, string>): boolean {
  const value = headers["proxy-status"]
  return value !== undefined && /(?:^|[;,]\s*)error\s*=/i.test(value)
}

export function proxyResponseFailure(
  status: number,
  headers: Record<string, string>,
): "proxy-authentication-failed" | "proxy-connection-failed" | undefined {
  if (status === 407) return "proxy-authentication-failed"
  if (hasProxyStatusError(headers)) return "proxy-connection-failed"
  return undefined
}

export function normalizeProxyError(err: unknown): "proxy-authentication-failed" | "proxy-connection-failed" {
  const message = err instanceof Error ? err.message : String(err)
  return /407|proxy authentication|proxy authorization required/i.test(message)
    ? "proxy-authentication-failed"
    : "proxy-connection-failed"
}

export function isProxyTransportFailure(err: unknown): boolean {
  return err instanceof Error && PROXY_TRANSPORT_FAILURE.test(err.message)
}
