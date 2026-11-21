import { t } from "./localization"
import type { Page } from "./page-history"

export type TourPlacement = "right" | "right-start" | "bottom-end"

export interface TourStep {
  id: string
  page: Page
  target: string
  title: string
  description: string
  detail: string
  placement?: TourPlacement
}
export function appTourSteps(phone: boolean, androidLocal: boolean, remote = false): TourStep[] {
  const steps: TourStep[] = [
    {
      id: "navigation",
      page: "overview",
      target: "navigation",
      title: t("tour.navigation.title"),
      description: t(`tour.navigation.${phone ? "phone" : "desktop"}`),
      detail: t("tour.navigation.detail"),
      placement: "right",
    },
    {
      id: "instance",
      page: "connections",
      target: "instance",
      title: t("tour.instance.title"),
      description: t("tour.instance.description"),
      detail: t(`tour.instance.${androidLocal ? "android" : "desktop"}`),
    },
    {
      id: "server",
      page: "overview",
      target: "server",
      title: t("tour.server.title"),
      description: t(`tour.server.${phone ? "phone" : "desktop"}`),
      detail: t("tour.server.detail"),
      placement: "bottom-end",
    },
    {
      id: "create",
      page: "overview",
      target: "new-request",
      title: t("tour.create.title"),
      description: t("tour.create.description"),
      detail: t("tour.create.detail"),
    },
    {
      id: "send",
      page: "workbench",
      target: "request-target",
      title: t("tour.send.title"),
      description: t("tour.send.description"),
      detail: t("tour.send.detail"),
    },
    {
      id: "history",
      page: "history",
      target: "request-history",
      title: t("tour.history.title"),
      description: t("tour.history.description"),
      detail: t("tour.history.detail"),
    },
    {
      id: "sessions",
      page: "sessions",
      target: "sessions",
      title: t("tour.sessions.title"),
      description: t("tour.sessions.description"),
      detail: t("tour.sessions.detail"),
    },
    {
      id: "settings",
      page: "settings",
      target: "settings-search",
      title: t("tour.settings.title"),
      description: t("tour.settings.description"),
      detail: t(`tour.settings.${remote ? "remote" : androidLocal ? "android" : "desktop"}`),
    },
    {
      id: "preferences",
      page: "connections",
      target: "preferences",
      title: t("tour.preferences.title"),
      description: t("tour.preferences.description"),
      detail: t("tour.preferences.detail"),
    },
    {
      id: "commands",
      page: "overview",
      target: "commands",
      title: t("tour.commands.title"),
      description: t("tour.commands.description"),
      detail: t("tour.commands.detail"),
      placement: "right-start",
    },
    {
      id: "refresh",
      page: "overview",
      target: phone ? "page-navigation" : "refresh",
      title: t("tour.refresh.title"),
      description: t(`tour.refresh.${phone ? "phone" : "desktop"}`),
      detail: t("tour.refresh.detail"),
      placement: "bottom-end",
    },
  ]
  return androidLocal ? steps.filter((step) => step.id !== "sessions") : steps
}

export interface TourRect {
  x: number
  y: number
  width: number
  height: number
}
export function tourPlacement(
  target: TourRect,
  card: { width: number; height: number; minHeight?: number },
  viewport: { width: number; height: number; x?: number; y?: number },
  preferred: TourPlacement = "right-start",
) {
  const margin = 16,
    gap = 14
  const width = Math.min(card.width, viewport.width - margin * 2)
  const height = Math.min(card.height, viewport.height - margin * 2)
  const left = (viewport.x ?? 0) + margin,
    top = (viewport.y ?? 0) + margin
  const right = (viewport.x ?? 0) + viewport.width - margin,
    bottom = (viewport.y ?? 0) + viewport.height - margin
  const clampX = (x: number) => Math.max(left, Math.min(x, right - width))
  const clampY = (y: number) => Math.max(top, Math.min(y, bottom - height))
  const alignedY = preferred === "right" ? target.y + (target.height - height) / 2 : target.y
  const below = { x: clampX(target.x + (target.width - width) / 2), y: target.y + target.height + gap }
  const candidates = [
    { x: target.x + target.width + gap, y: clampY(alignedY) },
    { x: target.x - width - gap, y: clampY(alignedY) },
    below,
    { x: clampX(target.x + (target.width - width) / 2), y: target.y - height - gap },
  ]
  if (preferred === "bottom-end")
    candidates.unshift({ x: clampX(target.x + target.width - width), y: Math.max(top, target.y + target.height + gap) })
  const fits = (p: { x: number; y: number }) =>
    p.x >= left && p.y >= top && p.x + width <= right && p.y + height <= bottom
  const best = candidates.find(fits)
  if (!best) {
    const above = Math.max(0, Math.min(bottom, target.y - gap) - top)
    const below = Math.max(0, bottom - Math.max(top, target.y + target.height + gap))
    const available = Math.max(above, below)
    if (available >= (card.minHeight ?? 140))
      return {
        x: clampX(target.x + (target.width - width) / 2),
        y: above >= below ? top : Math.max(top, target.y + target.height + gap),
        width,
        maxHeight: available,
      }
  }
  return {
    x: clampX((best ?? below).x),
    y: clampY((best ?? below).y),
    width,
  }
}
