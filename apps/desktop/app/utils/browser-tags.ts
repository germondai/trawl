import type { BrowserInstallation } from "../stores/desktop"

export interface BrowserTagDefinition {
  label: string
  description: string
  color: "primary" | "neutral" | "info" | "error"
  variant: "subtle" | "outline"
  class?: string
}

export const browserTags = {
  recommended: {
    label: "Recommended",
    description: "The default build verified and recommended for TRAWL.",
    color: "primary",
    variant: "subtle",
  },
  latest: {
    label: "Latest",
    description: "The newest supported non-nightly, non-deprecated build in the catalog for this platform.",
    color: "info",
    variant: "subtle",
  },
  active: {
    label: "Active",
    description: "The selected browser version used when the server starts.",
    color: "primary",
    variant: "outline",
  },
  installed: {
    label: "Installed",
    description: "A ready installation that is available to select.",
    color: "neutral",
    variant: "subtle",
  },
  "not-installed": {
    label: "Not installed",
    description: "An available catalog build that has not been downloaded.",
    color: "neutral",
    variant: "subtle",
    class: "text-muted",
  },
  "repair-ready": {
    label: "Repair ready",
    description: "A repaired copy is prepared. Stop the server, then choose Apply repair.",
    color: "neutral",
    variant: "subtle",
    class: "bg-teal-400/10 text-teal-300 ring-teal-400/25",
  },
  "repair-needed": {
    label: "Needs repair",
    description: "The installation exists but its files or verification are incomplete.",
    color: "neutral",
    variant: "subtle",
    class: "bg-orange-400/10 text-orange-300 ring-orange-400/25",
  },
  "update-available": {
    label: "Unsupported version",
    description: "An installed version that is not in the supported catalog.",
    color: "error",
    variant: "subtle",
  },
  unsupported: {
    label: "Unsupported platform",
    description: "A browser build that is unavailable for this operating system or architecture.",
    color: "error",
    variant: "subtle",
  },
  unknown: {
    label: "Unknown",
    description: "An installation whose browser version could not be identified.",
    color: "neutral",
    variant: "subtle",
    class: "bg-yellow-400/10 text-yellow-300 ring-yellow-400/25",
  },
  deprecated: {
    label: "Deprecated",
    description: "A build explicitly marked as deprecated in the catalog. Prefer a recommended replacement.",
    color: "neutral",
    variant: "subtle",
    class: "bg-orange-400/10 text-orange-300 ring-orange-400/25",
  },
  nightly: {
    label: "Nightly",
    description: "An experimental build from the nightly release channel. It is not the recommended default.",
    color: "neutral",
    variant: "subtle",
    class: "bg-violet-400/10 text-violet-300 ring-violet-400/25",
  },
} satisfies Record<string, BrowserTagDefinition>

export type BrowserTag = keyof typeof browserTags
type BrowserChoice = NonNullable<BrowserInstallation["choices"]>[number]
const stateTags: Record<string, BrowserTag> = {
  ready: "installed",
  "not-installed": "not-installed",
  "repair-needed": "repair-needed",
  "update-available": "update-available",
  unsupported: "unsupported",
  unknown: "unknown",
}

export function browserChoiceTags(choice: Partial<BrowserChoice>): BrowserTag[] {
  const tags: BrowserTag[] = []
  if (choice.supported !== false && !choice.deprecated && !choice.nightly) {
    if (choice.recommended) tags.push("recommended")
    if (choice.latest) tags.push("latest")
  }
  if (choice.deprecated) tags.push("deprecated")
  if (choice.nightly) tags.push("nightly")
  if (choice.pending) tags.push("repair-ready")
  if (choice.active) tags.push("active")
  if (!choice.installed || !choice.active)
    tags.push(choice.installed ? "installed" : (stateTags[choice.state ?? "not-installed"] ?? "unknown"))
  return tags
}
