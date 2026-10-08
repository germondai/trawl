import type { Page } from "patchright"

export async function restoreSessionStorage(page: Page, storage: Map<string, [string, string][]>) {
  return page.addInitScript(
    (entries: [string, [string, string][]][]) => {
      const values = entries.find(([origin]) => origin === location.origin)?.[1]
      if (!values) return
      try {
        // Redirects may revisit an origin already initialized in this request.
        if (sessionStorage.length) return
        for (const [key, value] of values) sessionStorage.setItem(key, value)
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "SecurityError")) throw error
      }
    },
    [...storage],
  )
}
