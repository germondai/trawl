import { normalizeShortcut } from "@trawl/config/catalog"

export function eventShortcut(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac: boolean,
): string | null {
  if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return null
  const names: Record<string, string> = {
    Comma: ",",
    Period: ".",
    Slash: "/",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Backquote: "`",
    Equal: "=",
    Minus: "-",
  }
  const key = /^(Key[A-Z]|Digit[0-9])$/.test(event.code)
    ? event.code.replace(/^(Key|Digit)/, "")
    : (names[event.code] ?? event.code)
  try {
    return normalizeShortcut(
      ["CmdOrCtrl", ...(event.altKey ? ["Alt"] : []), ...(event.shiftKey ? ["Shift"] : []), key].join("+"),
    )
  } catch {
    return null
  }
}
