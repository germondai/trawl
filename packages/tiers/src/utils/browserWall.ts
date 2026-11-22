import { hasAnubisDestinationContent, isAnubisVerificationUrl } from "./anubis"
import {
  type ChallengeType,
  hasAkamaiChallenge,
  hasAnubisChallenge,
  hasBaxiaPunish,
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
  solved: readonly string[] = [],
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
  // Still on the punish page (or its stub) after the solver ran: the slide did not pass, or the
  // block is a login jump that no widget clears. A slide that did pass leaves the page on the
  // stub when there is no referrer to return to (it calls history.go(-2) on a one-entry history),
  // so a solved NC is the proof of clearance and the stub is not a wall.
  if (!solved.includes("baxia-nc") && (hasBaxiaPunish(html, headers) || /\/_____tmd_____\/punish/.test(url)))
    return { reason: "baxia-persistent" }
  if (isBlocked(status, html)) return { reason: `http-${status}` }
}
