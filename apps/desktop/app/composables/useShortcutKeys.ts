import { formatShortcut, type ShortcutAction } from "@trawl/config/catalog"

export function useShortcutKeys() {
  const desktop = useDesktopStore()
  const mac = /Mac/.test(navigator.platform)
  return (action: ShortcutAction) => {
    const shortcut = desktop.config.desktop.keybindings[action]
    return shortcut
      ? formatShortcut(shortcut, mac)
          .split("+")
          .map((key) => (key === "Cmd" ? "command" : key.length > 1 ? key.toLowerCase() : key))
      : []
  }
}
