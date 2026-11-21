import { expect, test } from "bun:test"
import { settings } from "../src/catalog"
import { appLocales, isAppLanguage, messages, messageTemplate, resolveAppLocale, translate } from "../src/i18n"
import { shortcutDefinitions } from "../src/keybindings"

const placeholders = (message: string) => [...new Set(message.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g))].sort()

test("bundled languages have complete messages, matching placeholders and all required plural forms", () => {
  const keys = Object.keys(messages.en).sort()
  for (const locale of appLocales) {
    expect(Object.keys(messages[locale]).sort()).toEqual(keys)
    for (const key of keys) {
      const english = messages.en[key]
      if (!english) throw new Error(`Missing English message: ${key}`)
      const reference = typeof english === "string" ? english : english.other
      const message = messages[locale][key]
      if (!message) throw new Error(`Missing ${locale} message: ${key}`)
      expect(typeof message).toBe(typeof english)
      const forms = typeof message === "string" ? [message] : Object.values(message)
      for (const form of forms) {
        expect(form?.trim().length, `${locale}: ${key}`).toBeGreaterThan(0)
        expect(placeholders(form ?? ""), `${locale}: ${key}`).toEqual(placeholders(reference))
      }
      if (typeof message !== "string")
        for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories)
          expect(message[category], `${locale}: ${key}.${category}`).toBeDefined()
    }
  }
  for (const setting of settings) {
    expect(messages.en[`settings.${setting.name}.label`], setting.name).toBeDefined()
    expect(messages.en[`settings.${setting.name}.description`], setting.name).toBe(setting.description)
  }
  for (const action of Object.keys(shortcutDefinitions)) expect(messages.en[`shortcuts.${action}.label`]).toBeDefined()
})

test("System is default and resolves a supported regional preference with English fallback", () => {
  expect(resolveAppLocale(undefined, ["cs-CZ"])).toBe("cs")
  expect(resolveAppLocale()).toBe("en")
  expect(resolveAppLocale("en", ["cs-CZ"])).toBe("en")
  expect(resolveAppLocale("system", ["ja-JP", "CS_cz", "de-AT"])).toBe("cs")
  expect(resolveAppLocale("system", ["pt-BR", "de-AT"])).toBe("de")
  expect(resolveAppLocale("system", ["ja"])).toBe("en")
  expect(resolveAppLocale("unknown")).toBe("en")
  expect(isAppLanguage("system")).toBe(true)
  for (const invalid of [null, "cz", "cs-CZ", "toString", 1]) expect(isAppLanguage(invalid)).toBe(false)
})

test("Slavic counts and decimals select their own grammatical forms", () => {
  for (const locale of ["cs", "sk", "pl"] as const) {
    const rules = new Intl.PluralRules(locale)
    const entry = messages[locale]["counts.seconds"]
    if (typeof entry === "string" || !entry) throw new Error("Missing plural message")
    for (const count of [0, 1, 2, 5, 12, 22, 1.5]) {
      expect(messageTemplate(locale, "counts.seconds", count)).toBe(entry[rules.select(count)] ?? entry.other)
      expect(translate(locale, "counts.seconds", { count })).toContain(new Intl.NumberFormat(locale).format(count))
    }
  }
  expect(translate("cs", "counts.seconds", { count: 1 })).toBe("1 sekunda")
  expect(translate("sk", "counts.minutes", { count: 2 })).toBe("2 minúty")
  expect(translate("pl", "counts.requests", { count: 5 })).toBe("5 żądań")
  expect(translate("de", "counts.minutes", { count: 2 })).toBe("2 Minuten")
  expect(translate("fr", "counts.minutes", { count: 1 })).toBe("1 minute")
})

test("interpolation keeps user content literal, missing entries fall back to English", () => {
  const original = messages.cs["native.instance"]
  if (!original) throw new Error("Missing instance message")
  try {
    delete messages.cs["native.instance"]
    expect(translate("cs", "native.instance", { name: "<b>{name}</b>" })).toBe("Instance: <b>{name}</b>")
    expect(translate("en", "native.instance")).toBe("Instance: {name}")
    expect(translate("cs", "unknown.message")).toBe("unknown.message")
    expect(translate("cs", "toString")).toBe("toString")
    expect(translate("cs", "__proto__")).toBe("__proto__")
  } finally {
    messages.cs["native.instance"] = original
  }
})
