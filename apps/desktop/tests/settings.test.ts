import { expect, test } from "bun:test"
import { settingByName, settings } from "@trawl/config/catalog"
import androidSettings from "../../../native/mobile-runtime/assets/catalog.json"
import {
  applyDnsSettings,
  groupedSettings,
  sectionFor,
  settingLabel,
  settingSections,
  settingValueHint,
} from "../app/utils/settings"

function setting(name: string) {
  const result = settingByName.get(name)
  if (!result) throw new Error(`Missing setting ${name}`)
  return result
}

test("settings are discoverable in a named category, including session and proxy exceptions", () => {
  const groups = new Set(settingSections.map(({ id }) => id))
  for (const setting of settings)
    expect(groups.has(sectionFor(setting) as (typeof settingSections)[number]["id"])).toBe(true)
  expect(sectionFor(setting("BROWSER_SESSION_MAX_ENTRIES"))).toBe("sessions")
  expect(sectionFor(setting("SCRAPE_PROXY_SELECTION"))).toBe("proxies")
  expect(settingLabel(setting("PORT"))).toBe("API port")
})
test("setting summaries show readable units without displaying a secret value", () => {
  const timeout = setting("SCRAPE_MAX_TIMEOUT_MS")
  expect(settingValueHint(timeout, "30000")).toBe("30 seconds")
  expect(settingValueHint({ ...timeout, secret: true }, "private-api-key")).toBe("Configured · value hidden")
})

test("Android categories contain only settings offered by its runtime", () => {
  const groups = groupedSettings(androidSettings.filter((setting) => setting.name !== "DNS_SERVERS"))
  expect(groups.map((group) => group.id)).toEqual(["general", "proxies"])
  expect(groups.every((group) => group.settings.length > 0)).toBe(true)
  expect(groupedSettings([])).toEqual([])
})

test("limited remote catalogs use only their available category", () => {
  const groups = groupedSettings([setting("METRICS_DB_PATH")])
  expect(groups.map((group) => group.id)).toEqual(["metrics"])
  expect(groups[0]?.settings[0]?.name).toBe("METRICS_DB_PATH")
})

test("choosing the inherited DNS clears redundant overrides and obsolete custom servers", () => {
  const draft = { DNS_RESOLVER: "cloudflare", DNS_SERVERS: "1.1.1.1", PORT: "8192" }
  expect(applyDnsSettings(draft, {}, { resolver: "system", servers: "" })).toEqual({ PORT: "8192" })
  expect(draft.DNS_RESOLVER).toBe("cloudflare")
  expect(applyDnsSettings(draft, { DNS_RESOLVER: "cloudflare" }, { resolver: "cloudflare", servers: "" })).toEqual({
    PORT: "8192",
  })
})

test("DNS choices preserve explicit values when the inherited environment differs", () => {
  expect(applyDnsSettings({}, { DNS_RESOLVER: "cloudflare" }, { resolver: "system", servers: "" })).toEqual({
    DNS_RESOLVER: "system",
  })
  expect(applyDnsSettings({}, {}, { resolver: "google", servers: "" })).toEqual({ DNS_RESOLVER: "google" })
  expect(applyDnsSettings({}, {}, { resolver: "custom", servers: "1.1.1.1,8.8.8.8" })).toEqual({
    DNS_RESOLVER: "custom",
    DNS_SERVERS: "1.1.1.1,8.8.8.8",
  })
  expect(
    applyDnsSettings(
      { DNS_SERVERS: "1.1.1.1" },
      { DNS_RESOLVER: "custom", DNS_SERVERS: "8.8.8.8" },
      { resolver: "custom", servers: "8.8.8.8" },
    ),
  ).toEqual({})
})
