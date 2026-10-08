import { hasAnubisDestinationContent, isAnubisVerificationUrl } from "./anubis"
import {
  type ChallengeType,
  hasAkamaiChallenge,
  hasAnubisChallenge,
  hasDataDomeChallenge,
  hasDdosGuardChallenge,
  hasDuckDuckGoChallenge,
  hasImpervaChallenge,
  isBlocked,
  isCloudflarePage,
} from "./detect"
import { isGoogleSorryUrl } from "./googleSorry"

/** Assess the current document after solving and capture, preserving provider priority. */
export function persistentBrowserWall(
  html: string,
  url: string,
  headers: Record<string, string>,
  status: number,
  originalChallenge: ChallengeType,
): { reason: string; challenge?: "datadome" } | undefined {
  if (
    hasAnubisChallenge(html) ||
    isAnubisVerificationUrl(url) ||
    (originalChallenge === "anubis" && (status >= 400 || !hasAnubisDestinationContent(html)))
  )
    return { reason: "anubis-persistent" }
  if (isGoogleSorryUrl(url)) return { reason: "google-sorry-persistent" }
  if (isCloudflarePage(html, headers)) return { reason: "cloudflare-persistent" }
  if (hasImpervaChallenge(html)) return { reason: "imperva-persistent" }
  if (hasAkamaiChallenge(html)) return { reason: "akamai-persistent" }
  if (hasDdosGuardChallenge(html)) return { reason: "ddos-guard-persistent" }
  if (hasDataDomeChallenge(html)) return { reason: "datadome-persistent", challenge: "datadome" }
  if (hasDuckDuckGoChallenge(html)) return { reason: "duckduckgo-persistent" }
  if (isBlocked(status, html)) return { reason: `http-${status}` }
}
