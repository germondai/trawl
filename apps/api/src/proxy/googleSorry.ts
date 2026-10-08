import { isGoogleSorryUrl } from "@trawl/tiers"

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export function isGoogleSorryRedirect(status: number, location: string | undefined, requestUrl: string): boolean {
  if (!REDIRECT_STATUSES.has(status) || !location) return false
  try {
    return isGoogleSorryUrl(new URL(location, requestUrl).href)
  } catch {
    return false
  }
}
