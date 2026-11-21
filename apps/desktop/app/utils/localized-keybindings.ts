import { shortcutDefinitions } from "@trawl/config/catalog"
import { t } from "./localization"

export function shortcutErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  const known: Record<string, string> = {
    "Shortcut is too long": "keyboard.tooLong",
    "Use Cmd/Ctrl with optional Alt or Shift": "keyboard.modifiers",
    "Use a letter, number, punctuation, navigation key or F1–F12": "keyboard.keys",
  }
  if (known[message]) return t(known[message])
  const reserved = /^(.+) is reserved for editing or system navigation$/.exec(message)
  if (reserved) return t("keyboard.reserved", { shortcut: reserved[1] })
  const duplicate = /^(.+) duplicates (.+)$/.exec(message)
  if (duplicate) {
    const label = (english: string) => {
      const entry = Object.entries(shortcutDefinitions).find(([, definition]) => definition.label === english)
      return entry ? t(`shortcuts.${entry[0]}.label`) : english
    }
    return t("keyboard.duplicate", { action: label(duplicate[1] ?? ""), other: label(duplicate[2] ?? "") })
  }
  return t("ui.invalidShortcut")
}
