import definitions from "./keybindings.json"

export const shortcutDefinitions = definitions
export type ShortcutAction = keyof typeof definitions
export type Keybindings = Record<ShortcutAction, string | null>
export const defaultKeybindings = (): Keybindings =>
  Object.fromEntries(
    Object.entries(definitions).map(([action, definition]) => [action, definition.default]),
  ) as Keybindings
const namedKeys = [
  "Enter",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]
export function normalizeShortcut(input: string): string | null {
  if (!input.trim()) return null
  if (input.length > 80) throw new Error("Shortcut is too long")
  const parts = input
    .replace(/⌘/g, "Cmd+")
    .split("+")
    .map((part) => part.trim())
  const rawKey = parts.pop() ?? ""
  const modifiers = parts.map((part) =>
    /^(cmd|command|ctrl|control|cmdorctrl)$/i.test(part)
      ? "CmdOrCtrl"
      : /^alt$/i.test(part)
        ? "Alt"
        : /^shift$/i.test(part)
          ? "Shift"
          : part,
  )
  if (
    !modifiers.includes("CmdOrCtrl") ||
    modifiers.some((part) => !["CmdOrCtrl", "Alt", "Shift"].includes(part)) ||
    new Set(modifiers).size !== modifiers.length
  )
    throw new Error("Use Cmd/Ctrl with optional Alt or Shift")
  const key = /^[a-z0-9]$/i.test(rawKey)
    ? rawKey.toUpperCase()
    : (namedKeys.find((key) => key.toLowerCase() === rawKey.toLowerCase()) ??
      (/^f([1-9]|1[0-2])$/i.test(rawKey) ? rawKey.toUpperCase() : rawKey))
  if (!/^[A-Z0-9,.;'[\]\\/`=-]$/.test(key) && !namedKeys.includes(key) && !/^F([1-9]|1[0-2])$/.test(key))
    throw new Error("Use a letter, number, punctuation, navigation key or F1–F12")
  return ["CmdOrCtrl", ...["Alt", "Shift"].filter((modifier) => modifiers.includes(modifier)), key].join("+")
}
const reserved = new Set([
  "CmdOrCtrl+A",
  "CmdOrCtrl+C",
  "CmdOrCtrl+X",
  "CmdOrCtrl+V",
  "CmdOrCtrl+Z",
  "CmdOrCtrl+Shift+Z",
  "CmdOrCtrl+Y",
  "CmdOrCtrl+H",
  "CmdOrCtrl+Alt+H",
  "CmdOrCtrl+M",
  "CmdOrCtrl+Tab",
  "CmdOrCtrl+Shift+Tab",
  "CmdOrCtrl+Space",
  "CmdOrCtrl+Alt+Space",
  "CmdOrCtrl+Alt+Escape",
])
function shortcutScopes(action: ShortcutAction): string[] {
  return "scope" in definitions[action]
    ? ["tray"]
    : ["connections", "settings", "quit"].includes(action)
      ? ["app", "tray"]
      : ["app"]
}
export function validateKeybindings(input: unknown): Keybindings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid keyboard shortcuts")
  const result = defaultKeybindings(),
    used = new Map<string, string>()
  for (const action of Object.keys(input))
    if (!Object.hasOwn(definitions, action)) throw new Error("Unknown shortcut action")
  const given = { ...input } as Record<string, unknown>
  const conflicts = (action: ShortcutAction, shortcut: string) =>
    Object.entries(given).some(
      ([other, value]) =>
        other !== action &&
        typeof value === "string" &&
        normalizeShortcut(value) === shortcut &&
        shortcutScopes(action).some((scope) => shortcutScopes(other as ShortcutAction).includes(scope)),
    )
  // Move the former sidebar default once; explicit bindings in the new schema stay editable.
  if (
    given.server === undefined &&
    typeof given.sidebar === "string" &&
    normalizeShortcut(given.sidebar) === "CmdOrCtrl+S"
  )
    given.sidebar = conflicts("sidebar", "CmdOrCtrl+B") ? null : "CmdOrCtrl+B"
  // New defaults never displace an existing custom combination in the same menu.
  for (const action of [
    "search",
    "sidebar",
    "server",
    "restart",
    ...Object.keys(definitions).filter((action) => action.startsWith("trayInstance")),
  ] as ShortcutAction[]) {
    const shortcut = result[action]
    if (given[action] === undefined && shortcut && conflicts(action, shortcut)) result[action] = null
  }
  for (const action of Object.keys(definitions) as ShortcutAction[]) {
    const value = given[action]
    if (value !== undefined && value !== null && typeof value !== "string") throw new Error("Invalid keyboard shortcut")
    const shortcut = value === undefined ? result[action] : value === null ? null : normalizeShortcut(value)
    if (shortcut && reserved.has(shortcut)) throw new Error(`${shortcut} is reserved for editing or system navigation`)
    for (const scope of shortcutScopes(action)) {
      const identity = `${scope}:${shortcut}`
      if (shortcut && used.has(identity))
        throw new Error(`${definitions[action].label} duplicates ${used.get(identity)}`)
      if (shortcut) used.set(identity, definitions[action].label)
    }
    result[action] = shortcut
  }
  return result
}
export function formatShortcut(value: string | null, mac = false): string {
  if (!value) return "Not set"
  return value.replace("CmdOrCtrl", mac ? "Cmd" : "Ctrl")
}
