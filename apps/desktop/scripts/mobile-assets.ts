import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dnsProviders, emptyConfig, settings } from "@trawl/config/catalog"

const folder = new URL("../../../native/mobile-runtime/assets/", import.meta.url)
await mkdir(folder, { recursive: true })
const config = emptyConfig()
config.env = {
  HOST: "127.0.0.1",
  PORT: "8191",
  SCRAPE_MAX_TIMEOUT_MS: "60000",
  SCRAPE_MIN_TIER: "1",
  SCRAPE_MAX_TIER: "3",
  DNS_RESOLVER: "system",
  DNS_SERVERS: "",
}
await writeFile(new URL("dns-providers.json", folder), `${JSON.stringify(dnsProviders, null, 2)}\n`)
const supported = new Set([...Object.keys(config.env), "API_KEY"])
await writeFile(new URL("config.json", folder), `${JSON.stringify(config, null, 2)}\n`)
const catalog = settings
  .filter((item) => supported.has(item.name))
  .map((item) => {
    if (item.name === "HOST") return { ...item, default: "127.0.0.1" }
    if (item.name === "SCRAPE_MIN_TIER")
      return {
        ...item,
        choices: ["1", "3"],
        description: "Minimum execution tier: 1 uses HTTP first; 3 always uses the Android System WebView.",
      }
    if (item.name === "SCRAPE_MAX_TIMEOUT_MS") return { ...item, max: 180000 }
    return item
  })
catalog.push({
  name: "SCRAPE_MAX_TIER",
  kind: "enum",
  default: "3",
  choices: ["1", "3"],
  group: "scrape",
  restart: true,
  description: "Maximum execution tier: 1 allows HTTP only; 3 also allows Android System WebView rendering.",
})
catalog.push({
  name: "API_KEY",
  kind: "string",
  default: "",
  secret: true,
  group: "api",
  restart: false,
  description:
    "Bearer key for clients connecting to this Android server. A private key is generated automatically. Enter your own key of at least 16 characters to connect another client.",
})
await writeFile(new URL("catalog.json", folder), `${JSON.stringify(catalog, null, 2)}\n`)
const formatted = Bun.spawnSync(
  [
    process.execPath,
    "x",
    "biome",
    "format",
    "--write",
    ...["config.json", "catalog.json", "dns-providers.json"].map((name) => fileURLToPath(new URL(name, folder))),
  ],
  { stdout: "inherit", stderr: "inherit" },
)
if (formatted.exitCode !== 0) throw new Error("Could not format generated mobile assets")
