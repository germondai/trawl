import { existsSync } from "node:fs"
import { join } from "node:path"
import type { BrowserFingerprint } from "@trawl/types"

// Firefox 152 matches the pinned Camoufox 152.0.4 browser shipped in the image.
// The full upstream bundle carries fonts for all of these profiles.
const ALL_FINGERPRINTS: ReadonlyArray<BrowserFingerprint> = [
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
    platform: "Win32",
    locale: "en-US",
    timezone: "America/New_York",
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0",
    platform: "MacIntel",
    locale: "en-US",
    timezone: "America/Los_Angeles",
  },
  {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
    platform: "Linux x86_64",
    locale: "en-US",
    timezone: "Europe/London",
  },
  {
    userAgent: "Mozilla/5.0 (X11; Linux armv8; rv:152.0) Gecko/20100101 Firefox/152.0",
    platform: "Linux armv8",
    locale: "en-US",
    timezone: "Asia/Tokyo",
  },
]

/**
 * Keep the advertised OS consistent with the font bundles actually available to
 * Camoufox. Managed local installs do not set CAMOUFOX_INSTALL_DIR and retain the
 * upstream all-OS behavior; our containers set it to their baked browser bundle.
 */
export function resolveFingerprintPool(
  installDir = process.env.CAMOUFOX_INSTALL_DIR,
): ReadonlyArray<BrowserFingerprint> {
  if (!installDir) return ALL_FINGERPRINTS

  const macResources = join(installDir, "Camoufox.app", "Contents", "Resources")
  const fontRoot = existsSync(macResources) ? macResources : installDir
  const hasWindowsFonts = existsSync(join(fontRoot, "fonts", "windows"))
  const hasMacosFonts = existsSync(join(fontRoot, "fonts", "macos"))

  return ALL_FINGERPRINTS.filter((fingerprint) => {
    if (fingerprint.platform === "Win32") return hasWindowsFonts
    if (fingerprint.platform === "MacIntel") return hasMacosFonts
    return true
  })
}

// Picked from by the pool per browser instance so HTTP headers, browser fingerprint,
// and installed fonts stay consistent. Linux profiles guarantee this is never empty.
export const FINGERPRINT_POOL = resolveFingerprintPool()

const defaultFingerprint = FINGERPRINT_POOL[0]

// HTTP-level fallback used before a browser is acquired and if browser-side UA
// evaluation fails. It must come from the same runtime-eligible pool.
export const FINGERPRINT = {
  ...defaultFingerprint,
  viewport: { width: 1920, height: 1080 },
  hardwareConcurrency: 8,
  deviceMemory: 8,
} as const
