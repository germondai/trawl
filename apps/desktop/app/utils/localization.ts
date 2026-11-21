import {
  type AppLanguage,
  type AppLocale,
  type MessageParameters,
  messages,
  messageTemplate,
  resolveAppLocale,
  translate,
} from "@trawl/config/i18n"
import { shallowRef } from "vue"

// The desktop frontend is a client-only application; native processes read the same catalogs separately.
export const appLocale = shallowRef<AppLocale>("en")
export function applyAppLanguage(
  language: AppLanguage,
  preferred: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
) {
  appLocale.value = resolveAppLocale(language, preferred)
}
export function t(key: string, parameters?: MessageParameters) {
  return translate(appLocale.value, key, parameters)
}
/** Retain message identity so an open validation error follows later language changes. */
export class LocalizedError extends Error {
  constructor(key: string, parameters?: MessageParameters) {
    super()
    Object.defineProperty(this, "message", { get: () => t(key, parameters), configurable: true })
  }
}
const nativeErrors = new Map<string, string>()
const nativeErrorTemplates: { key: string; expression: RegExp; parameters: string[] }[] = []
for (const [key, message] of Object.entries(messages.en)) {
  if (!key.startsWith("native.error.") || typeof message !== "string") continue
  const parameters = [...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  )
  if (!parameters.length) nativeErrors.set(message, key)
  else {
    const parts = message.split(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g)
    const expression = new RegExp(
      `^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("([\\s\\S]*?)")}$`,
    )
    nativeErrorTemplates.push({ key, expression, parameters })
  }
}
export function nativeErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? "")
  if (message.startsWith("native.") && Object.hasOwn(messages.en, message)) return t(message)
  const key = nativeErrors.get(message)
  if (key) return t(key)
  for (const template of nativeErrorTemplates) {
    const match = template.expression.exec(message)
    if (match) return t(template.key, Object.fromEntries(template.parameters.map((name, i) => [name, match[i + 1]])))
  }
  return message
}
export function tTemplate(key: string, count?: number) {
  return messageTemplate(appLocale.value, key, count)
}
export function formatLocale() {
  return appLocale.value
}
