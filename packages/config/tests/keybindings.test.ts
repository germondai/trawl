import { expect, test } from "bun:test"
import { eventShortcut } from "../../../apps/desktop/app/utils/keybindings"
import { validateConfig } from "../../runtime/src/store"
import { emptyConfig } from "../src/catalog"
import { defaultKeybindings, normalizeShortcut, validateKeybindings } from "../src/keybindings"

test("shortcuts normalize modifiers, retain explicit disabling and reject conflicts", () => {
  expect(normalizeShortcut(" shift + Cmd + n ")).toBe("CmdOrCtrl+Shift+N")
  expect(normalizeShortcut("Ctrl+Alt+ArrowUp")).toBe("CmdOrCtrl+Alt+ArrowUp")
  expect(normalizeShortcut("⌘N")).toBe("CmdOrCtrl+N")
  expect(validateKeybindings({ quit: null }).quit).toBeNull()
  expect(validateKeybindings({ workbench: "Cmd+Shift+N" }).workbench).toBe("CmdOrCtrl+Shift+N")
  expect(() => validateKeybindings({ workbench: "Cmd+R" })).toThrow("duplicates")
  for (const input of ["N", "Cmd+Cmd+N", "Cmd+Control+N", "Cmd+Unknown", "Cmd+F13"])
    expect(() => normalizeShortcut(input)).toThrow()
  expect(() => validateKeybindings({ toString: "Cmd+N" })).toThrow("Unknown")
  expect(() => validateKeybindings({ history: "Ctrl+C" })).toThrow("reserved")
  expect(validateKeybindings({})).toEqual(defaultKeybindings())
})
test("older preference documents gain scrolling and complete shortcuts; explicit choices persist", () => {
  const config = emptyConfig()
  const legacy = {
    ...config,
    desktop: { closeBehavior: "tray", autostart: false, startServerOnLaunch: false, connections: [] },
  }
  const migrated = validateConfig(legacy)
  expect(migrated.desktop.smoothScroll).toBe(true)
  expect(migrated.desktop.liveActivities).toBe(true)
  expect(migrated.desktop.keybindings).toEqual(defaultKeybindings())
  expect(
    validateConfig({
      ...config,
      desktop: { ...config.desktop, smoothScroll: false, keybindings: { quit: null, workbench: "Cmd+Shift+N" } },
    }).desktop,
  ).toMatchObject({ smoothScroll: false, keybindings: { quit: null, workbench: "CmdOrCtrl+Shift+N" } })
  expect(() => validateConfig({ ...config, desktop: { ...config.desktop, smoothScroll: "false" } })).toThrow(
    "preferences",
  )
})

test("live activities default on, retain an explicit opt-out and reject non-boolean values", () => {
  const config = emptyConfig()
  expect(config.desktop.liveActivities).toBe(true)
  expect(
    validateConfig({ ...config, desktop: { ...config.desktop, liveActivities: false } }).desktop.liveActivities,
  ).toBe(false)
  expect(() => validateConfig({ ...config, desktop: { ...config.desktop, liveActivities: "false" } })).toThrow(
    "preferences",
  )
})
test("tray shortcuts have their own context while duplicates within that menu are rejected", () => {
  const defaults = validateKeybindings({})
  expect(defaults.trayOpen).toBe("CmdOrCtrl+O")
  expect(defaults.trayServer).toBe(defaults.server)
  expect(defaults.sidebar).toBe("CmdOrCtrl+B")
  expect(defaults.restart).toBe("CmdOrCtrl+Shift+R")
  expect(defaults.trayRestart).toBe(defaults.refresh)
  expect(() => validateKeybindings({ trayOpen: "Cmd+R" })).toThrow("duplicates")
  for (const key of ["Q", ",", "."]) expect(() => validateKeybindings({ trayOpen: `Cmd+${key}` })).toThrow("duplicates")
  expect(validateKeybindings({ trayOpen: null }).trayOpen).toBeNull()
})
test("legacy sidebar defaults move to Cmd-B while custom and disabled combinations survive", () => {
  const legacy = Object.fromEntries(
    Object.entries(defaultKeybindings()).filter(
      ([action]) => !["server", "restart"].includes(action) && !action.startsWith("trayInstance"),
    ),
  )
  legacy.sidebar = "CmdOrCtrl+S"
  const migrated = validateKeybindings(legacy)
  const config = emptyConfig()
  expect(
    validateConfig({ ...config, desktop: { ...config.desktop, keybindings: legacy } }).desktop.keybindings,
  ).toEqual(migrated)
  expect(migrated).toMatchObject({ sidebar: "CmdOrCtrl+B", server: "CmdOrCtrl+S", restart: "CmdOrCtrl+Shift+R" })
  expect(validateKeybindings(migrated)).toEqual(migrated)
  expect(legacy.sidebar).toBe("CmdOrCtrl+S")
  expect(validateKeybindings({ sidebar: "Cmd+Alt+B" }).sidebar).toBe("CmdOrCtrl+Alt+B")
  expect(validateKeybindings({ sidebar: "Cmd+S", server: null }).sidebar).toBe("CmdOrCtrl+S")
  expect(validateKeybindings({ sidebar: "Cmd+S", history: "Cmd+B", refresh: "Cmd+Shift+R" })).toMatchObject({
    sidebar: null,
    history: "CmdOrCtrl+B",
    restart: null,
  })
})
test("tray instance slots keep their own menu scope and yield to existing custom shortcuts", () => {
  const defaults = validateKeybindings({})
  expect(defaults.trayInstance1).toBe(defaults.overview)
  expect(defaults.trayInstance9).toBe("CmdOrCtrl+9")
  expect(validateKeybindings({ trayOpen: "Cmd+2" })).toMatchObject({ trayOpen: "CmdOrCtrl+2", trayInstance2: null })
  expect(() => validateKeybindings({ trayOpen: "Cmd+2", trayInstance2: "Cmd+2" })).toThrow("duplicates")
  expect(validateKeybindings({ trayInstance1: null }).trayInstance1).toBeNull()
})
test("command search adds Cmd-K without taking an existing custom application shortcut", () => {
  expect(validateKeybindings({}).search).toBe("CmdOrCtrl+K")
  expect(validateKeybindings({ history: "Cmd+K" })).toMatchObject({ history: "CmdOrCtrl+K", search: null })
  expect(validateKeybindings({ trayOpen: "Cmd+K" }).search).toBe("CmdOrCtrl+K")
  expect(() => validateKeybindings({ history: "Cmd+K", search: "Cmd+K" })).toThrow("duplicates")
})
test("preview matching uses physical keys on non-US layouts and exact modifiers", () => {
  const event = { code: "Digit1", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
  expect(eventShortcut(event, true)).toBe("CmdOrCtrl+1")
  expect(eventShortcut({ ...event, code: "KeyN", shiftKey: true }, true)).toBe("CmdOrCtrl+Shift+N")
  expect(eventShortcut({ ...event, metaKey: false, ctrlKey: true }, false)).toBe("CmdOrCtrl+1")
  expect(eventShortcut({ ...event, ctrlKey: true }, true)).toBeNull()
  expect(eventShortcut({ ...event, metaKey: false }, true)).toBeNull()
})
test("sidebar toggle preferences default safely and survive configuration validation", () => {
  const config = emptyConfig()
  expect(validateConfig(config).desktop.sidebarBehavior).toBe("collapse")
  config.desktop.sidebarBehavior = "hide"
  expect(validateConfig(config).desktop.sidebarBehavior).toBe("hide")
  expect(() => validateConfig({ ...config, desktop: { ...config.desktop, sidebarBehavior: "cycle" } })).toThrow(
    "preferences",
  )
})
