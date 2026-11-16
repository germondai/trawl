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
export const geoipAsset: Download = {
  url: "https://github.com/P3TERX/GeoLite.mmdb/releases/download/2026.11.13/GeoLite2-City.mmdb",
  size: 50559043,
  sha256: "1ffc2e3e2c0d83a11cb64dfaa318e6f10f74aae131dd18899d5243eaf81c0364",
}
export const uboAsset: Download = {
  size: 4650100,
  url: "https://addons.mozilla.org/firefox/downloads/file/5034826/ublock_origin-1.75.0.xpi",
  sha256: "5b74415860456370644bd80f16125e865b0e6c356bb5dfcfb84069967eaa5287",
}
