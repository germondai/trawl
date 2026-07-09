// Shared "hard network failure" check — duplicated verbatim in tier3/tier4's goto-error
// handling before this extraction. These are Chromium/Playwright ERR_* strings that mean
// the browser never reached a server, so there's no point running challenge-wait logic.
const HARD_NETWORK_FAILURE =
  /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/i

export function isHardNetworkFailure(err: unknown): err is Error {
  return err instanceof Error && HARD_NETWORK_FAILURE.test(err.message)
}
