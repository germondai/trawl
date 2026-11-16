export const pages = [
  { id: "overview", label: "Overview", icon: "i-lucide-activity" },
  { id: "history", label: "Requests", icon: "i-lucide-network" },
  { id: "workbench", label: "New request", icon: "i-lucide-plus" },
  { id: "browser", label: "Browser", icon: "i-lucide-globe" },
  { id: "settings", label: "Server settings", icon: "i-lucide-settings-2" },
  { id: "logs", label: "Logs", icon: "i-lucide-terminal" },
  { id: "connections", label: "Connections", icon: "i-lucide-network" },
] as const
export type Page = (typeof pages)[number]["id"]
export interface PageHistory {
  entries: Page[]
  index: number
}
export function visitPage(history: PageHistory, page: Page): PageHistory {
  if (history.entries[history.index] === page) return history
  return { entries: [...history.entries.slice(0, history.index + 1), page], index: history.index + 1 }
}
export function movePage(history: PageHistory, direction: -1 | 1): PageHistory {
  const index = history.index + direction
  return index < 0 || index >= history.entries.length ? history : { ...history, index }
}
