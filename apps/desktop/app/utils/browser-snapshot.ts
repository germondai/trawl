import type { BrowserObservationSnapshot } from "@trawl/client"
export function browserSnapshotKey(value?: BrowserObservationSnapshot) {
  if (!value) return ""
  return JSON.stringify({
    ...value,
    pages: value.pages.map(({ observedAt: _time, ...page }) => page).sort((a, b) => a.id.localeCompare(b.id)),
  })
}
