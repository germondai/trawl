import type { Download } from "./assets"

export const browserVersion = "152.0.4-beta.30"
const version = browserVersion
const base = `https://github.com/daijro/camoufox/releases/download/v${version}/camoufox-${version}-`
export const browserAssets: Record<string, Download> = {
  "darwin-arm64": {
    url: `${base}mac.arm64.zip`,
    size: 312665777,
    sha256: "3b43e766574f286a6a63296cf58b660b7a3120952086c869b4df4c9a71604bc3",
  },
  "darwin-x64": {
    url: `${base}mac.x86_64.zip`,
    size: 319886717,
    sha256: "f12f90a3650478e670064a2f071c13b998fdd1125f79dc9f6cad5a9b9395b4bc",
  },
  "linux-arm64": {
    url: `${base}lin.arm64.zip`,
    size: 653870625,
    sha256: "60447260af8bebdb0ec3f2aa72f687b879e5598367303de2e3fdbc7a5be8c124",
  },
  "linux-x64": {
    url: `${base}lin.x86_64.zip`,
    size: 663467670,
    sha256: "5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672",
  },
  "win32-x64": {
    url: `${base}win.x86_64.zip`,
    size: 493141328,
    sha256: "ea52a02fb1cfb1813ef6a326bea03fb2b650c9774143d953a94a27bfc8f10072",
  },
}
// Native builds only expose versions with verified protocol and security resources for their platform.
export interface BrowserBuild {
  engine: "camoufox"
  name: string
  version: string
  launcher: "legacy" | "official"
  channel?: "release" | "nightly"
  deprecated?: boolean
  securityManifestHash?: string
  assets: Record<string, Download>
}
export const supportedBrowsers: readonly BrowserBuild[] = [
  { engine: "camoufox", name: "Camoufox Firefox", version: browserVersion, launcher: "legacy", assets: browserAssets },
  {
    engine: "camoufox",
    name: "Camoufox Firefox",
    version: "156.0.1-beta.32",
    launcher: "official",
    assets: {
      "darwin-arm64": {
        url: "https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.32/camoufox-156.0.1-beta.32-mac.arm64.zip",
        size: 1289761949,
        sha256: "531c29fb82ab37dc57e934658de04540861de9b9811473298d88ebdea075b566",
      },
    } as Record<string, Download>,
  },
  {
    engine: "camoufox",
    name: "Camoufox Firefox",
    version: "156.0.1-beta.33",
    launcher: "official",
    assets: {
      "darwin-arm64": {
        url: "https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.33/camoufox-156.0.1-beta.33-mac.arm64.zip",
        size: 1289766069,
        sha256: "ab51bb25c3c2be86cc8943483d046638d3f7064de3563df6a75015bf589bd23d",
      },
    },
  },
  {
    engine: "camoufox",
    name: "Camoufox Firefox",
    version: "156.0.1-beta.36",
    launcher: "official",
    assets: {
      "darwin-arm64": {
        url: "https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.36/camoufox-156.0.1-beta.36-mac.arm64.zip",
        size: 1289762241,
        sha256: "0ad5663e40f4a2a836e28747256b79f39a5105905f1b244139a7a391f85fda32",
      },
    },
  },
  {
    engine: "camoufox",
    name: "Camoufox Firefox",
    version: "156.0.1-beta.39",
    launcher: "official",
    securityManifestHash: "7f7ba6ed070487a4a4f7996c6a316eec3e88a261dadf6bd068fd301622bb6054",
    assets: {
      "darwin-arm64": {
        url: "https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.39/camoufox-156.0.1-beta.39-mac.arm64.zip",
        size: 1289869847,
        sha256: "9f754b10adbb0e146fe1fa17e1f61136a90e15692fb51eb213b02922a932fb6c",
      },
    },
  },
]
export const browserBuild = (version: string | undefined) =>
  supportedBrowsers.find((build) => build.version === version)
export function browserBuildLabels(
  version: string,
  platform = `${process.platform}-${process.arch}`,
  catalog: readonly BrowserBuild[] = supportedBrowsers,
) {
  const build = catalog.find((build) => build.version === version)
  const builds = catalog.filter((build) => build.assets[platform] && !build.deprecated && build.channel !== "nightly")
  return {
    latest: builds.at(-1)?.version === version,
    recommended: builds.some((build) => build.version === version) && version === browserVersion,
    deprecated: build?.deprecated === true,
    nightly: build?.channel === "nightly",
  }
}
export const geoipAsset: Download = {
  url: "https://github.com/P3TERX/GeoLite.mmdb/releases/download/2026.11.13/GeoLite2-City.mmdb",
  size: 50559043,
  sha256: "1ffc2e3e2c0d83a11cb64dfaa318e6f10f74aae131dd18899d5243eaf81c0364",
}
export const uboAsset: Download = {
  size: 6371851,
  url: "https://addons.mozilla.org/firefox/downloads/file/5282683/ublock_origin-1.76.6.xpi",
  sha256: "debffadf7d5117bd2d4e9218e27bfdf3112544fd2e87f14882d274a11dc95375",
}
