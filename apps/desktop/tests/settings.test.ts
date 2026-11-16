import { expect, test } from "bun:test"
import { settingByName, settings } from "@trawl/config/catalog"
import { sectionFor, settingLabel, settingSections, settingValueHint } from "../app/utils/settings"

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
