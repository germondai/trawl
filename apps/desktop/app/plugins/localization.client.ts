import { invoke } from "@tauri-apps/api/core"
import { type AppLocale, appLocales } from "@trawl/config/i18n"
import { appLocale, applyAppLanguage } from "~/utils/localization"

export default defineNuxtPlugin((nuxtApp) => {
  const desktop = useDesktopStore()
  const update = () => {
    const language = desktop.config.desktop.language ?? "system"
    if (desktop.native && language === "system") return
    applyAppLanguage(language)
  }
  const stop = watch(() => desktop.config.desktop.language, update, { immediate: true, flush: "sync" })
  const languageChanged = async () => {
    update()
    if (desktop.native && (desktop.config.desktop.language ?? "system") === "system") {
      try {
        const locale = await invoke<AppLocale>("app_locale")
        if ((desktop.config.desktop.language ?? "system") === "system")
          appLocale.value = appLocales.includes(locale) ? locale : "en"
      } catch (error) {
        console.warn(error)
      }
    }
  }
  window.addEventListener("languagechange", languageChanged)
  const cleanup = () => {
    stop()
    window.removeEventListener("languagechange", languageChanged)
  }
  nuxtApp.vueApp.onUnmount(cleanup)
  if (import.meta.hot) import.meta.hot.dispose(cleanup)
  useHead(() => ({
    htmlAttrs: {
      lang: appLocale.value,
      dir: "ltr",
      "data-language-ready": desktop.preferencesReady ? undefined : "false",
    },
  }))
})
