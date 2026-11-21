import cs from "../locales/cs.json"
import de from "../locales/de.json"
import en from "../locales/en.json"
import fr from "../locales/fr.json"
import pl from "../locales/pl.json"
import sk from "../locales/sk.json"

export const appLocales = ["en", "cs", "sk", "pl", "de", "fr"] as const
export type AppLocale = (typeof appLocales)[number]
export type AppLanguage = AppLocale | "system"
export type Message = string | (Partial<Record<Intl.LDMLPluralRule, string>> & { other: string })
export type MessageParameters = Record<string, string | number | boolean | null | undefined>
export const localeNames: Record<AppLocale, string> = {
  en: "English",
  cs: "Čeština",
  sk: "Slovenčina",
  pl: "Polski",
  de: "Deutsch",
  fr: "Français",
}
export const messages: Record<AppLocale, Record<string, Message>> = { en, cs, sk, pl, de, fr }
export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "system" || appLocales.includes(value as AppLocale)
}
export function resolveAppLocale(language: unknown = "system", preferred: readonly string[] = []): AppLocale {
  if (language !== "system") return appLocales.includes(language as AppLocale) ? (language as AppLocale) : "en"
  for (const locale of preferred) {
    const base = locale.toLowerCase().replaceAll("_", "-").split("-")[0] as AppLocale
    if (appLocales.includes(base)) return base
  }
  return "en"
}
const pluralRules = new Map<AppLocale, Intl.PluralRules>()
export function messageTemplate(locale: AppLocale, key: string, count = 0): string {
  const entry =
    (Object.hasOwn(messages[locale], key) ? messages[locale][key] : undefined) ??
    (Object.hasOwn(messages.en, key) ? messages.en[key] : undefined)
  if (!entry) return key
  let message: string
  if (typeof entry === "string") message = entry
  else {
    let rules = pluralRules.get(locale)
    if (!rules) {
      rules = new Intl.PluralRules(locale)
      pluralRules.set(locale, rules)
    }
    message = entry[rules.select(count)] ?? entry.other
  }
  return message
}
export function translate(locale: AppLocale, key: string, parameters: MessageParameters = {}): string {
  const message = messageTemplate(locale, key, Number(parameters.count ?? 0))
  return message.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name: string) =>
    Object.hasOwn(parameters, name)
      ? name === "count" && typeof parameters[name] === "number"
        ? new Intl.NumberFormat(locale).format(parameters[name])
        : String(parameters[name] ?? "")
      : match,
  )
}
