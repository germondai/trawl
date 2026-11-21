import type { BrowserInstallation } from "../stores/desktop"
import { t } from "./localization"

export interface BrowserTagDefinition {
  label: string
  description: string
  color: "primary" | "neutral" | "info" | "error"
  variant: "subtle" | "outline"
  class?: string
}

export const browserTags = {
  recommended: {
    get label() {
      return t("ui.recommended")
    },
    get description() {
      return t("ui.theDefaultBuildVerifiedAndRecommendedForTrawl")
    },
    color: "primary",
    variant: "subtle",
  },
  latest: {
    get label() {
      return t("ui.latest")
    },
    get description() {
      return t("ui.theNewestSupportedNonNightlyNonDeprecatedBuild")
    },
    color: "info",
    variant: "subtle",
  },
  active: {
    get label() {
      return t("ui.active")
    },
    get description() {
      return t("ui.theSelectedBrowserVersionUsedWhenTheServer")
    },
    color: "primary",
    variant: "outline",
  },
  installed: {
    get label() {
      return t("ui.installed")
    },
    get description() {
      return t("ui.aReadyInstallationThatIsAvailableToSelect")
    },
    color: "neutral",
    variant: "subtle",
  },
  "not-installed": {
    get label() {
      return t("ui.notInstalled")
    },
    get description() {
      return t("ui.anAvailableCatalogBuildThatHasNotBeen")
    },
    color: "neutral",
    variant: "subtle",
    class: "text-muted",
  },
  "repair-ready": {
    get label() {
      return t("ui.repairReady")
    },
    get description() {
      return t("ui.aRepairedCopyIsPreparedStopTheServer")
    },
    color: "neutral",
    variant: "subtle",
    class: "bg-teal-400/10 text-teal-300 ring-teal-400/25",
  },
  "repair-needed": {
    get label() {
      return t("ui.needsRepair")
    },
    get description() {
      return t("ui.theInstallationExistsButItsFilesOrVerification")
    },
    color: "neutral",
    variant: "subtle",
    class: "bg-orange-400/10 text-orange-300 ring-orange-400/25",
  },
  "update-available": {
    get label() {
      return t("ui.unsupportedVersion")
    },
    get description() {
      return t("ui.anInstalledVersionThatIsNotInThe")
    },
    color: "error",
    variant: "subtle",
  },
  unsupported: {
    get label() {
      return t("ui.unsupportedPlatform")
    },
    get description() {
      return t("ui.aBrowserBuildThatIsUnavailableForThis")
    },
    color: "error",
    variant: "subtle",
  },
  unknown: {
    get label() {
      return t("ui.unknown")
    },
    get description() {
      return t("ui.anInstallationWhoseBrowserVersionCouldNotBe")
    },
    color: "neutral",
    variant: "subtle",
    class: "bg-yellow-400/10 text-yellow-300 ring-yellow-400/25",
  },
  deprecated: {
    get label() {
      return t("ui.deprecated")
    },
    get description() {
      return t("ui.aBuildExplicitlyMarkedAsDeprecatedInThe")
    },
    color: "neutral",
    variant: "subtle",
    class: "bg-orange-400/10 text-orange-300 ring-orange-400/25",
  },
  nightly: {
    get label() {
      return t("ui.nightly")
    },
    get description() {
      return t("ui.anExperimentalBuildFromTheNightlyReleaseChannel")
    },
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
