import { join } from "node:path"
import { Camoufox as legacy } from "camoufox-js"

export async function launchCamoufox(options: NonNullable<Parameters<typeof legacy>[0]> = {}) {
  const directory = process.env.CAMOUFOX_INSTALL_DIR
  if (process.env.TRAWL_BROWSER_LAUNCHER !== "official") return legacy(options)
  if (!directory) throw new Error("A managed browser directory is required for this launcher")
  const { Camoufox } = await import("camoufox")
  const config = { ...(options.config ?? {}) }
  if (options.geoip) {
    const { publicIP, ProxyHelper } = await import("camoufox-js/dist/ip.js")
    const { getGeolocation } = await import("camoufox-js/dist/locale.js")
    const ip =
      typeof options.geoip === "string"
        ? options.geoip
        : await publicIP(
            typeof options.proxy === "string"
              ? options.proxy
              : options.proxy
                ? ProxyHelper.asString(options.proxy)
                : undefined,
          )
    Object.assign(config, (await getGeolocation(ip)).asConfig())
  }
  // Keep the existing verified GeoIP database and explicit executable; the launcher must not fetch a replacement.
  return Camoufox({
    ...options,
    config,
    geoip: false,
    executable_path:
      process.platform === "darwin"
        ? join(directory, "Camoufox.app/Contents/MacOS/camoufox")
        : join(directory, process.platform === "win32" ? "camoufox.exe" : "camoufox-bin"),
  })
}
