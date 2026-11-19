export const pages = [
  { id: "overview", label: "Overview", icon: "i-lucide-activity", group: "Workspace" },
  { id: "workbench", label: "New request", icon: "i-lucide-plus", group: "Workspace" },
  { id: "history", label: "Requests", icon: "i-lucide-network", group: "Workspace" },
  { id: "sessions", label: "Sessions", icon: "i-lucide-layers", group: "Workspace" },
  { id: "browser", label: "Browser", icon: "i-lucide-globe", group: "Runtime" },
  { id: "resources", label: "Resources", icon: "i-lucide-gauge", group: "Runtime" },
  { id: "logs", label: "Logs", icon: "i-lucide-terminal", group: "Runtime" },
  { id: "settings", label: "Server settings", icon: "i-lucide-settings-2", group: "Manage" },
  { id: "connections", label: "App settings", icon: "i-lucide-settings", group: "Manage" },
] as const
export type Page = (typeof pages)[number]["id"]
export function cyclePage(page: Page, direction: -1 | 1): Page {
  const order: Page[] = [
    "overview",
    "history",
    "sessions",
    "workbench",
    "browser",
    "resources",
    "logs",
    "connections",
    "settings",
  ]
  return order[(order.indexOf(page) + direction + order.length) % order.length] ?? page
}
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
