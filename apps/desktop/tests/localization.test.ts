import { expect, test } from "bun:test"
import { validateEnvironment } from "@trawl/config"
import { settings, validateKeybindings } from "@trawl/config/catalog"
import { appLocales, messages, translate } from "@trawl/config/i18n"
import { computed } from "vue"
import { useErrorMessage } from "../app/composables/useErrorMessage"
import { eventShortcut } from "../app/utils/keybindings"
import { appLocale, LocalizedError, nativeErrorMessage, t } from "../app/utils/localization"
import { shortcutErrorMessage } from "../app/utils/localized-keybindings"
import { pages } from "../app/utils/page-history"
import { settingDescription, settingLabel, settingSections } from "../app/utils/settings"
import { newWorkbenchDraft, workbenchRequest } from "../app/utils/workbench"

test("visible errors retain their identity across all languages without modifying original diagnostics", () => {
  const error = useErrorMessage()
  const original = new Error("The filesystem picker closed unexpectedly")
  error.value = original
  const caption = computed(() => error.value)
  try {
    for (const locale of appLocales) {
      appLocale.value = locale
      expect(caption.value).toBe(t("native.error.theFilesystemPickerClosedUnexpectedly"))
      expect(t("ui.raw")).toBe("Raw")
    }
    expect(original.message).toBe("The filesystem picker closed unexpectedly")
    error.value = new LocalizedError("ui.invalidFields")
    appLocale.value = "de"
    expect(caption.value).toBe(t("ui.invalidFields"))
    error.value = "Original remote diagnostic {details}"
    expect(caption.value).toBe("Original remote diagnostic {details}")
    error.value = undefined
    expect(caption.value).toBe("")
  } finally {
    appLocale.value = "en"
  }
})

test("known native, SDK and runtime errors translate at presentation while template details stay literal", () => {
  try {
    for (const locale of appLocales) {
      appLocale.value = locale
      for (const [key, source] of Object.entries(messages.en)) {
        if (!key.startsWith("native.error.") || typeof source !== "string") continue
        const parameters = Object.fromEntries(
          [...source.matchAll(/\{(\w+)\}/g)].flatMap((match) => (match[1] ? [[match[1], "{details} (test) $1"]] : [])),
        )
        const original = translate("en", key, parameters)
        expect(nativeErrorMessage(new Error(original)), `${locale}: ${key}`).toBe(t(key, parameters))
      }
      expect(nativeErrorMessage("Download failed (HTTP 502)")).toBe(
        t("native.error.downloadFailedHTTPStatus", { status: "502" }),
      )
    }
  } finally {
    appLocale.value = "en"
  }
})

test("settings validation errors from the runtime retain technical field names and follow the UI language", () => {
  const errors = [{ PORT: "invalid" }, { METRICS_DASHBOARD_TOKEN: "short" }].map((input) => {
    try {
      validateEnvironment(input)
    } catch (cause) {
      return cause
    }
    throw new Error("Expected settings validation failure")
  })
  try {
    for (const locale of appLocales) {
      appLocale.value = locale
      expect(nativeErrorMessage(errors[0])).toBe(
        t("native.error.nameHasAnInvalidKindValue", { name: "PORT", kind: "integer" }),
      )
      expect(nativeErrorMessage(errors[1])).toBe(
        t("native.error.nameMustContainAtLeast32Characters", { name: "METRICS_DASHBOARD_TOKEN" }),
      )
    }
  } finally {
    appLocale.value = "en"
  }
})

test("navigation and setting presentation react to locale while identities and shortcuts stay stable", () => {
  const ids = pages.map(({ id, group }) => ({ id, group }))
  const port = settings.find(({ name }) => name === "PORT")
  if (!port) throw new Error("Missing port setting")
  const heading = computed(() => pages.find(({ id }) => id === "settings")?.label)
  const description = computed(() => settingDescription(port))
  const validation = new LocalizedError("ui.invalidFields")
  const error = computed(() => validation.message)
  const english = { heading: heading.value, description: description.value, error: error.value }
  try {
    appLocale.value = "cs"
    expect(heading.value).toBe(t("ui.serverSettings"))
    expect(heading.value).not.toBe(english.heading)
    expect(description.value).not.toBe(english.description)
    expect(error.value).not.toBe(english.error)
    expect(settingLabel(port)).toBe("Port API")
    expect(pages.map(({ id, group }) => ({ id, group }))).toEqual(ids)
    expect(settingSections.map(({ id }) => id)).toContain("proxies")
    expect(eventShortcut({ code: "KeyQ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe(
      "CmdOrCtrl+Q",
    )
    expect(settingDescription({ name: "PORT", description: "Unknown server text" })).toBe("Unknown server text")
  } finally {
    appLocale.value = "en"
  }
})

test("open validation and native update errors translate their full message after a language change", () => {
  const draft = { ...newWorkbenchDraft(), url: "https://owned.example", headers: "invalid JSON" }
  let validation: unknown
  let shortcut: unknown
  try {
    workbenchRequest(draft)
  } catch (cause) {
    validation = cause
  }
  try {
    validateKeybindings({ workbench: "Cmd+1" })
  } catch (cause) {
    shortcut = cause
  }
  const error = computed(() => nativeErrorMessage(validation))
  const updateError = computed(() => nativeErrorMessage("native.releaseConnectionFailed"))
  const english = { error: error.value, update: updateError.value }
  try {
    appLocale.value = "cs"
    expect(error.value).toBe(t("validation.jsonSyntax", { label: t("ui.headers") }))
    expect(error.value).not.toBe(english.error)
    expect(updateError.value).not.toBe(english.update)
    expect(shortcutErrorMessage(shortcut)).toContain(t("shortcuts.workbench.label"))
    expect(shortcutErrorMessage(shortcut)).toContain(t("shortcuts.overview.label"))
    expect(nativeErrorMessage("Original remote error {name}")).toBe("Original remote error {name}")
  } finally {
    appLocale.value = "en"
  }
})

test("native bootstrap waits for the effective System language and saving language preserves request tabs", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "-e",
      `
      import assert from "node:assert/strict"
      import {createPinia, defineStore, setActivePinia} from "pinia"
      import {emptyConfig} from "@trawl/config/catalog"
      globalThis.window={crypto:globalThis.crypto}
      globalThis.isTauri=true
      const {mockIPC}=await import("@tauri-apps/api/mocks")
      let config=emptyConfig(), resolveLocale
      config.desktop.language="system"
      mockIPC(async(command,args)=>{
        if(command==="app_locale")return new Promise(resolve=>{resolveLocale=resolve})
        if(command==="instance_status")return {running:false}
        if(command==="management") {
          if(args.request.action==="saveConfig"){config=args.request.config;return config}
          return {config,inherited:{},effective:{},sources:{},catalog:[],status:{running:false},browser:{installed:true},startupError:"Port must be between 1 and 65535"}
        }
        throw new Error("Unexpected IPC command: "+command)
      })
      const {useDesktopStore}=await import("./app/stores/desktop.ts")
      const {appLocale,t}=await import("./app/utils/localization.ts")
      Object.assign(globalThis,{defineStore,useDesktopStore})
      const {useWorkbenchStore}=await import("./app/stores/workbench.ts")
      setActivePinia(createPinia())
      const desktop=useDesktopStore(), workbench=useWorkbenchStore()
      workbench.addTab()
      workbench.draft.url="https://owned.example/?q={user}"
      workbench.draft.headers='{"X-Owned":"příliš žluťoučký"}'
      const tabs=workbench.tabs, active=workbench.activeTabId, data=JSON.stringify(workbench.draft)
      const initial=desktop.bootstrap()
      await Bun.sleep(0)
      assert.equal(desktop.preferencesReady,false)
      assert.equal(desktop.loaded,false)
      resolveLocale("pl")
      await initial
      assert.equal(desktop.preferencesReady,true)
      assert.equal(appLocale.value,"pl")
      assert.equal(desktop.error,t("native.error.portMustBeBetween1And65535"))
      assert.equal(desktop.config.desktop.language,"system")
      const next=JSON.parse(JSON.stringify(desktop.config));next.desktop.language="de"
      assert.equal(await desktop.save(next),true)
      assert.equal(appLocale.value,"de")
      assert.equal(desktop.error,t("native.error.portMustBeBetween1And65535"))
      assert.equal(workbench.tabs,tabs)
      assert.equal(workbench.activeTabId,active)
      assert.equal(JSON.stringify(workbench.draft),data)
    `,
    ],
    cwd: `${import.meta.dir}/..`,
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})
