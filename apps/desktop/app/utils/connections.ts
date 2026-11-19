import type { Connection } from "@trawl/config/catalog"

export function connectionChanges(
  previous: Connection,
  draft: { name: string; baseURL: string; apiKey: string; removeKey: boolean },
): Connection {
  const { apiKey: stored, ...connection } = previous
  const apiKey = draft.removeKey ? undefined : draft.apiKey || stored
  return {
    ...connection,
    name: draft.name.trim(),
    baseURL: draft.baseURL.trim(),
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
}
