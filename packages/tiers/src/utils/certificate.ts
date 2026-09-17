// TLS verification failures, as they reach a `fetch()` rejection under Bun.
//
// Bun surfaces OpenSSL's verify result as `err.code` (e.g. `DEPTH_ZERO_SELF_SIGNED_CERT`
// with message "self signed certificate"); Node-compatible paths add `ERR_TLS_*` codes and
// sometimes bury the original error one `cause` deep. Matching on the code — not on the
// prose — keeps "concert", "certainly" and other incidental text out of the classifier.
const CERTIFICATE_ERROR_CODES = new Set([
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
])

// Fallback for runtimes that drop the code but keep OpenSSL's wording. Deliberately
// narrow: each alternative is a phrase only a certificate failure produces.
const CERTIFICATE_ERROR_MESSAGES =
  /self[- ]signed certificate|certificate has expired|certificate is not yet valid|unable to verify the first certificate|unable to get local issuer certificate|does not match certificate|altnames/i

const MAX_CAUSE_DEPTH = 4

// A certificate failure is one line; a wrapped error can carry a whole stack in its
// message — keep the first line so the reported reason stays a label, not a dump.
const firstLine = (message: string): string => message.split("\n")[0].trim()

interface ErrorLink {
  code?: string
  message: string
}

const errorChain = (err: unknown): ErrorLink[] => {
  const chain: ErrorLink[] = []
  let current: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code
    chain.push({ code: typeof code === "string" ? code : undefined, message: current.message })
    current = current.cause
  }
  return chain
}

const isCertificateLink = (link: ErrorLink): boolean =>
  (link.code !== undefined && CERTIFICATE_ERROR_CODES.has(link.code)) || CERTIFICATE_ERROR_MESSAGES.test(link.message)

export function isCertificateError(err: unknown): boolean {
  return errorChain(err).some(isCertificateLink)
}

// Short, stable description of why verification failed, for `ScrapeResult.certificateError`.
// The code is the part downstream keys on; the message is appended when there is one.
export function describeCertificateError(err: unknown): string {
  const link = errorChain(err).find(isCertificateLink)
  if (!link) return err instanceof Error ? firstLine(err.message) : String(err)
  if (!link.code) return firstLine(link.message)
  return link.message ? `${link.code}: ${firstLine(link.message)}` : link.code
}
