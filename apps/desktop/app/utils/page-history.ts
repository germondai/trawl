import { t } from "./localization"
export const pages = [
  {
    id: "overview",
    get label() {
      return t("ui.overview")
    },
    icon: "i-lucide-activity",
    group: "Workspace",
  },
  {
    id: "workbench",
    get label() {
      return t("ui.newRequest")
    },
    icon: "i-lucide-plus",
    group: "Workspace",
  },
  {
    id: "history",
    get label() {
      return t("ui.requests")
    },
    icon: "i-lucide-network",
    group: "Workspace",
  },
  {
    id: "sessions",
    get label() {
      return t("ui.sessions")
    },
    icon: "i-lucide-layers",
    group: "Workspace",
  },
  {
    id: "browser",
    get label() {
      return t("ui.browser")
    },
    icon: "i-lucide-globe",
    group: "Runtime",
  },
  {
    id: "resources",
    get label() {
      return t("ui.resources")
    },
    icon: "i-lucide-gauge",
    group: "Runtime",
  },
  {
    id: "logs",
    get label() {
      return t("ui.logs")
    },
    icon: "i-lucide-terminal",
    group: "Runtime",
  },
  {
    id: "settings",
    get label() {
      return t("ui.serverSettings")
    },
    icon: "i-lucide-settings-2",
    group: "Manage",
  },
  {
    id: "connections",
    get label() {
      return t("ui.appSettings")
    },
    icon: "i-lucide-settings",
    group: "Manage",
  },
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
