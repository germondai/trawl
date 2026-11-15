// DataDome fingerprint payload builder.
//
// Generates all ~150 browser signals that DataDome collects. Based on reverse engineering
// from https://github.com/pushjoman21/DataDome-Reverse-Engineering

import { djb2Hash, toInt32, toUint32 } from "./crypto"

type Random = () => number

// Browser profile for Chrome 148 on Windows 10
export interface BrowserProfile {
  ua: string
  pf: string
  hc: number
  dvm: number
  mob: boolean
  ts_mtp: number
  wbd: boolean
  lg: string
  lgs: string
  vnd: string
  bid: string
  glvd: string
  glrd: string
  rs_w: number
  rs_h: number
  rs_cd: number
  ars_w: number
  ars_h: number
  br_oh: number
  br_ow: number
  br_w: number
  br_h: number
  br_iw: number
  br_ih: number
  pr: number
  cg_w: number
  cg_h: number
  sg_w: number
  sg_h: number
  so: string
  plu: string
  plg: number
  plgne: boolean
  plgre: boolean
  plgof: boolean
  plggt: boolean
  plgod: boolean
  mmt: string
  med: string
  tz: number
  k_lyts: number
  k_lytk: string
  nhi: string
  eva: number
  cokys: string
  stqe: number
  stqu: number
  cssS: string
  css0: string
  css1: string
  cssH: string
  csssp: string
  niet: string
  nid: number
  nisd: boolean
  nt_nhp: string
}

export const CHROME_WIN_PROFILE: BrowserProfile = {
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  pf: "Win32",
  hc: 8,
  dvm: 8,
  mob: false,
  ts_mtp: 0,
  wbd: false,
  lg: "en-US",
  lgs: '["en-US","en"]',
  vnd: "Google Inc.",
  bid: "NA",
  glvd: "Google Inc. (NVIDIA)",
  glrd: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  rs_w: 1920,
  rs_h: 1080,
  rs_cd: 24,
  ars_w: 1920,
  ars_h: 1040,
  br_oh: 1040,
  br_ow: 1920,
  br_w: 1920,
  br_h: 929,
  br_iw: 1920,
  br_ih: 929,
  pr: 1,
  cg_w: 1920,
  cg_h: 0,
  sg_w: 0,
  sg_h: 48,
  so: "landscape-primary",
  plu: "PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF",
  plg: 5,
  plgne: true,
  plgre: true,
  plgof: false,
  plggt: false,
  plgod: false,
  mmt: "application/pdf,text/pdf",
  med: "defined",
  tz: -60,
  k_lyts: 48,
  k_lytk: "qwertyuiopasdfghjklzxcvbnm1234567890-=[];'#,./\\` ",
  nhi: "x86,64,false,,Windows,14.0.0,148.0.7778.179,false",
  eva: 40,
  cokys: ",loadTimes,csi,app,runtime",
  stqe: 10737418240,
  stqu: 0,
  cssS: "4.93,13.26,9.01,0.22,4.57,2.12,14.38,6.39,7.07",
  css0: "33, 4, 4",
  css1: "0.218751, 0.0134708, -0.0191417, 0.00133113, -0.160945, 4.09828, 1.04485, -0.0726597, 0.28419, -1.99897, 1.84097, -0.128023, 4.08665, -28.7452, 26.4731, -0.840966",
  cssH: "0px",
  csssp: "",
  niet: "4g",
  nid: 10,
  nisd: false,
  nt_nhp: "h2",
}

// bchk API list (from tags.js line 1913)
const BCHK_APIS = [
  "AppBannerPromptResult",
  "webkitRTCPeerConnection",
  "webkitAudioContext",
  "webkitRequestAnimationFrame",
  "chrome.runtime",
  "chrome.webstore",
  "console.context",
  "InputMethodContext",
  "SVGAnimationElement",
  "SVGPathSegList",
  "PasswordCredential",
  "ViewTransition",
  "VisualViewport.prototype.segments",
  "DeprecationReportBody",
  "MathMLElement",
  "opr",
  "CSS2Properties.prototype.colorScheme",
  "WebKitCSSMatrix",
  "SVGTextPositioningElement",
  "XMLHttpRequestEventTarget",
  "TextDecoderStream",
  "onloadend",
  "WritableStream",
  "TransformStream",
  "TextTrackCue",
  "WeakRef",
  "VisualViewport",
  "StyleSheet",
  "RTCDtlsTransport",
  "Atomics",
  "StaticRange",
  "UIEvent",
  "VideoStreamTrack",
  "OfflineResourceList",
  "SVGGeometryElement",
  "RTCDataChannel",
  "VTTRegion",
  "AbortController",
  "Controllers",
  "onanimationcancel",
  "SVGDocument",
  "IIRFilterNode",
  "RTCStatsReport",
  "MediaStreamTrack",
  "CSS2Properties.prototype.MozOsxFontSmoothing",
  "CropTarget",
  "BatteryManager",
  "LaunchQueue",
  "CSSFontPaletteValuesRule",
  "PushSubscriptionOptions",
  "DOMSettableTokenList",
  "RTCTrackEvent",
  "MozSmsMessage",
  "ServiceWorkerContainer",
  "CanvasCaptureMediaStream",
  "DeviceStorage",
  "XPathNSResolver",
  "SmartCardEvent",
  "WeakSet",
  "MozMobileMessageManager",
  "External.prototype.getHostEnvironmentValue",
  "WindowUtils",
  "XPathNamespace",
  "SVGFEDropShadowElement",
  "SharedWorker",
  "WorkerMessageEvent",
  "CSS2Properties.prototype.MozOSXFontSmoothing",
  "AudioSinkInfo",
  "Notification.prototype.image",
  "ContentVisibilityAutoStateChangeEvent",
  "PerformanceResourceTiming.prototype.renderBlockingStatus",
  "console.createTask",
  "PerformanceServerTiming",
  "CanvasFilter",
  "structuredClone",
  "onslotchange",
  "EyeDropper",
  "URLPattern",
  "VideoFrame",
  "WritableStreamDefaultController",
  "SharedArrayBuffer",
  "CSSCounterStyleRule",
  "CustomStateSet",
  "ReadableStreamDefaultController",
  "XMLDocument.prototype.hasStorageAccess",
  "CryptoKey",
  "SubmitEvent",
  "MediaMetadata",
  "VideoPlaybackQuality",
  "ReadableStreamDefaultReader",
  "UserActivation",
  "FragmentDirective",
  "WebKitMediaKeyError",
  "RTCRtpTransceiver.prototype.stop",
  "Scheduling",
  "EventCounts",
  "VideoTrackList",
  "SourceBuffer",
  "RTCError",
  "FontFaceSet",
  "CSSCharsetRule",
  "MediaDeviceInfo",
  "RTCPeerConnectionIceErrorEvent",
  "RTCSctpTransport",
  "MediaSessionCoordinator",
  "XULPopupElement",
  "MediaSourceHandle",
  "RTCEncodedAudioFrame",
  "__REACT_DEVTOOLS_GLOBAL_HOOK__",
  "ShadowRealm",
  "HTMLSlotElement",
  "DetachedViewControlEvent",
  "GeolocationPosition",
  "SiteBoundCredential",
  "MediaSource",
  "WebTransport",
  "GPUSupportedLimits",
  "ToggleEvent",
]

const BCHK_FOUND =
  "52738db37a1ea50137e79e8181193ac872cd325ba5cacfbe7aab5b36b9c9879e7c0018dbd31a1832a8dc6528387b67451719dcd8b784a518904e3f07c69b9d30"
const BCHK_ABSENT =
  "3829ae9642df0d791e41d2159da28bd18d056afadf1bd70fc9222a473eaf58e860ff950e7bf35b66e4aa90b156c80c96913dbd9c23c7262e4adbc3ddd77ff263"

// Chrome 148 APIs present
const CHROME_148_APIS_PRESENT = new Set([
  "webkitRTCPeerConnection",
  "webkitRequestAnimationFrame",
  "chrome.runtime",
  "console.context",
  "SVGAnimationElement",
  "PasswordCredential",
  "ViewTransition",
  "MathMLElement",
  "WebKitCSSMatrix",
  "SVGTextPositioningElement",
  "XMLHttpRequestEventTarget",
  "TextDecoderStream",
  "WritableStream",
  "TransformStream",
  "TextTrackCue",
  "WeakRef",
  "VisualViewport",
  "StyleSheet",
  "RTCDtlsTransport",
  "Atomics",
  "StaticRange",
  "UIEvent",
  "SVGGeometryElement",
  "RTCDataChannel",
  "AbortController",
  "onanimationcancel",
  "IIRFilterNode",
  "RTCStatsReport",
  "MediaStreamTrack",
  "CropTarget",
  "BatteryManager",
  "LaunchQueue",
  "CSSFontPaletteValuesRule",
  "PushSubscriptionOptions",
  "RTCTrackEvent",
  "ServiceWorkerContainer",
  "WeakSet",
  "SVGFEDropShadowElement",
  "SharedWorker",
  "AudioSinkInfo",
  "Notification.prototype.image",
  "ContentVisibilityAutoStateChangeEvent",
  "PerformanceResourceTiming.prototype.renderBlockingStatus",
  "console.createTask",
  "PerformanceServerTiming",
  "structuredClone",
  "onslotchange",
  "EyeDropper",
  "URLPattern",
  "VideoFrame",
  "WritableStreamDefaultController",
  "CSSCounterStyleRule",
  "CustomStateSet",
  "ReadableStreamDefaultController",
  "XMLDocument.prototype.hasStorageAccess",
  "CryptoKey",
  "SubmitEvent",
  "MediaMetadata",
  "VideoPlaybackQuality",
  "ReadableStreamDefaultReader",
  "UserActivation",
  "FragmentDirective",
  "RTCRtpTransceiver.prototype.stop",
  "Scheduling",
  "EventCounts",
  "SourceBuffer",
  "RTCError",
  "MediaDeviceInfo",
  "RTCPeerConnectionIceErrorEvent",
  "RTCSctpTransport",
  "MediaSourceHandle",
  "RTCEncodedAudioFrame",
  "HTMLSlotElement",
  "GeolocationPosition",
  "MediaSource",
  "WebTransport",
  "GPUSupportedLimits",
  "ToggleEvent",
])

// Video codecs (Chrome defaults)
const CHROME_VIDEO_CODECS: Record<string, unknown> = {
  vco: "",
  vcots: false,
  vch: "probably",
  vchts: true,
  vcw: "probably",
  vcwts: true,
  vc3: "maybe",
  vc3ts: false,
  vcmp: "",
  vcmpts: false,
  vc1: "probably",
  vc1ts: true,
  vcmk: "maybe",
  vcmkuts: false,
  vcq: "",
  vcqts: false,
}

// Audio codecs (Chrome defaults)
const CHROME_AUDIO_CODECS: Record<string, unknown> = {
  aco: "probably",
  acots: false,
  acmp: "probably",
  acmpts: true,
  acmpu: "maybe",
  acmputs: false,
  acw: "probably",
  acwts: false,
  acma: "maybe",
  acmats: false,
  acaa: "probably",
  acaats: true,
  ac3: "",
  ac3ts: false,
  acf: "probably",
  acfts: false,
  acmp4: "maybe",
  acmp4ts: false,
  acmp3: "probably",
  acmp3ts: false,
  acwm: "maybe",
  acwmts: false,
}

// Feature detection (Chrome 148 defaults)
const CHROME_FEATURES: Record<string, boolean> = {
  pro_t: true, // Promise.prototype.then
  wglo: true, // WebGL supported
  prso: true, // Performance.prototype.setResourceTimingBufferSize
  wbst: true, // WebSocket
  psn: true, // PushSubscription
  edp: true, // EventTarget.prototype.dispatchEvent
  addt: true, // AudioContext.prototype.decodeAudioData
  wsdc: true, // WritableStreamDefaultController
  ccsr: true, // CSS.supports
  nuad: true, // navigator.userAgentData
  bcda: false, // BarcodeDetector (not in Chrome desktop)
  idn: true, // Intl.DisplayNames
  capi: false, // captureEvents (deprecated)
  svde: false, // SVGDefsElement (not standard)
  vpbq: true, // VideoPlaybackQuality
}

// Bot detection (all false = not a bot)
const CHROME_BOT_CHECKS: Record<string, boolean> = {
  awe: false, // awesomium
  phe: false, // phantomjs
  dat: false, // domAutomation
  nm: false, // nightmare
  geb: false, // webdriver (gecko)
  sqt: false, // selenium
  spwn: false, // spawn
  emt: false, // emit
}

// Generate navigation timing values
export function generateNavTiming(random: Random): Record<string, unknown> {
  const dns = Math.round(random() * 3 * 10) / 10
  const tcp = Math.round(random() * 5 * 10) / 10
  const tls = Math.round((random() * 12 + 3) * 1000000) / 1000000
  const requestStartOffset = Math.round(random() * 5 * 1000000) / 1000000
  const responseTime = Math.round((random() * 520 + 80) * 1000000) / 1000000
  const firstInterim = Math.round((random() * 15 - 10) * 1000000) / 1000000
  const swTime = Math.round(random() * 5 * 1000000) / 1000000

  const pageSize = 200000
  const encodedSize = pageSize
  const decodedSize = pageSize + Math.floor(random() * 250000 + 50000)
  const compressionDiff = decodedSize - encodedSize

  const domInteractive = Math.round((random() * 1500 + 500) * 1000000) / 1000000
  const dclDuration = Math.round((random() * 4.8 + 0.2) * 1000000) / 1000000
  const loadEventDuration = Math.round(random() * 2 * 10) / 10
  const domCompleteOffset = Math.round(random() * 100 * 10) / 10

  const connectEnd = tcp + tls
  const secureDiff = connectEnd > 0 ? connectEnd - tcp : 0
  const ntEsc = secureDiff > 0 ? Math.round(random() * 2 * 1000000) / 1000000 : 0

  const ttrdDenom = connectEnd - tcp > 0 ? connectEnd - tcp : 1
  const ttrdNumer = responseTime - ttrdDenom
  const ntTtrd = ttrdDenom !== 0 ? Math.round((ttrdNumer / ttrdDenom) * 1000000) / 1000000 : null

  return {
    nt_tcp: tcp,
    nt_dns: dns,
    nt_rd: 0,
    nt_irt: firstInterim,
    nt_rt: responseTime,
    nt_tls: tls,
    nt_ttf: Math.round((responseTime + swTime + 10) * 1000000) / 1000000,
    nt_swt: swTime,
    nt_csd: compressionDiff,
    nt_nhp: "h2",
    nt_rdc: 0,
    nt_it: "navigation",
    nt_prs: requestStartOffset,
    nt_esc: ntEsc,
    nt_ttrd: ntTtrd,
    nt_le: loadEventDuration,
    nt_dcle: dclDuration,
    nt_di: domInteractive,
    nt_dc: domCompleteOffset,
  }
}

// Generate trrd (complex trig formula from tags.js)
export function generateTrrd(random: Random): number {
  const sqrt2 = Math.sqrt(2)
  const r1 = random()
  const r2 = random()
  const r3 = random()
  const r4 = random()

  const e = Math.sqrt(
    Math.abs(
      Math.sin((Math.PI / 90) * 100 - 40 * r1 * (Math.PI / 180) / 2) +
        Math.cos(100 * sqrt2 * (Math.PI / 180)) *
          Math.sin((Math.PI / 180) * 40 - 100 * r2 * (Math.PI / 75) / 2),
    ),
  )

  const cVal =
    r3 *
    Math.sqrt(
      Math.abs(
        1 -
          Math.sin(40 * r4 * (Math.PI / 90) - (100 * sqrt2 * (Math.PI / 180)) / 2) +
          Math.cos(3.7055555555555557) *
            random() *
            Math.sin((Math.PI / 180) * 60 - (Math.PI / 45) * (100 / 2)),
      ),
    )

  return Math.atan2(e, cVal)
}

// Generate bchk (browser compatibility check hash)
export function generateBchk(apisPresent: Set<string> = CHROME_148_APIS_PRESENT): string {
  const result: string[] = []
  for (let i = 0; i < BCHK_APIS.length; i++) {
    const api = BCHK_APIS[i]
    if (apisPresent.has(api)) {
      result.push(BCHK_FOUND[i % BCHK_FOUND.length])
    } else {
      result.push(BCHK_ABSENT[i % BCHK_ABSENT.length])
    }
  }
  return result.join("")
}

// Generate error stacks (ccsT, ccsB, ccsH, ccsV)
export function generateErrorStacks(
  random: Random,
  tagsJsUrl = "https://www.example.com/include/tags.js",
): Record<string, unknown> {
  const line = 2
  const colT = Math.floor(random() * 2000 + 99000)
  const colB1 = Math.floor(random() * 2000 + 77000)
  const colB2 = Math.floor(random() * 2000 + 98000)
  const colB3 = Math.floor(random() * 2000 + 105000)

  const fullStack =
    `Error\n` +
    `at y1 (${tagsJsUrl}:${line}:${colT})\n` +
    `at ${tagsJsUrl}:${line}:${colB1}\n` +
    `at ${tagsJsUrl}:${line}:${colB2}\n` +
    `at ${tagsJsUrl}:${line}:${colB3}`

  const ccsT = fullStack.slice(0, 150)
  const ccsB = fullStack.slice(-150)
  const ccsH = djb2Hash(fullStack)

  // SHA256 hash for ccsV
  const encoder = new TextEncoder()
  const data = encoder.encode(fullStack)
  let hash = 0x6a09e667
  for (const byte of data) {
    hash = ((hash << 5) - hash + byte) >>> 0
  }
  const ccsV = hash.toString(16).padStart(64, "0")

  return { ccsT, ccsB, ccsH, ccsV }
}

// Generate r3n (_hsv)
export function generateR3n(random: Random, serverHash?: string): string | number {
  if (serverHash && serverHash.length >= 4) {
    const hashSuffix = serverHash.slice(-4)
    const randHex = Math.floor(random() * 0xffffffff)
      .toString(16)
      .toUpperCase()
      .padStart(8, "0")
    const pos = Math.floor(random() * 9)
    return randHex.slice(0, pos) + hashSuffix + randHex.slice(pos)
  }
  return 33
}

// Generate wdifpnh
export function generateWdifpnh(random: Random): string {
  return String(Math.floor(random() * 3294967295 + 1000000000))
}

// Compute fingerprint hash (fph)
export function computeFph(profile: BrowserProfile): number {
  const parts = [
    String(profile.glrd),
    String(profile.glvd),
    String(profile.ua),
    String(profile.hc),
    String(profile.lgs),
    String(profile.ts_mtp),
    String(profile.pf),
    String(profile.br_oh),
    String(profile.br_ow),
    "",
    "",
    "",
    "",
    String(profile.dvm),
  ]
  return djb2Hash(parts.join(""))
}

// Compute signal checksums (sgb, sgd, sgc)
export function computeChecksums(payload: Record<string, unknown>): {
  sgb: string
  sgd: string
  sgc: string
} {
  let L = 0 // sgb
  let P = 0 // sgd
  let j = 0 // sgc

  const T = (val: unknown) => {
    const h = djb2Hash(String(val))
    L ^= h
    j ^= h
  }

  const S = (val: unknown) => {
    const h = djb2Hash(String(val))
    P ^= h
    j ^= h
  }

  const m = (val: unknown) => {
    const h = djb2Hash(String(val))
    j ^= h
  }

  // Reproduce signal collection order from tags.js
  T(payload.lgs ?? "")
  S(payload.pf ?? "")
  S(String(payload.ts_mtp ?? 0) + "a")
  m(String(payload.mob ?? false) + "bb")
  m(String(payload.hc ?? 8) + "ccc")
  m(String(payload.dvm ?? 8) + "dddd")
  S(payload.tz ?? -60)
  T(payload.eva ?? 40)
  T(payload.wdifpnh ?? "")

  return {
    sgb: String(toUint32(L)),
    sgd: String(toUint32(P)),
    sgc: String(toUint32(j)),
  }
}

// Build the full payload with all ~150 signals
export function buildPayload(
  profile: BrowserProfile,
  url: string,
  serverHash: string,
  random: Random = Math.random,
): Record<string, unknown> {
  const domain = url.replace(/^https?:\/\//, "").split("/")[0]
  const tagsJsUrl = `https://${domain}/include/tags.js`

  const nowMs = Date.now()
  const jset = Math.floor(nowMs / 1000)
  const trrd = generateTrrd(random)
  const navTiming = generateNavTiming(random)
  const errorStacks = generateErrorStacks(random, tagsJsUrl)
  const wdifpnh = generateWdifpnh(random)
  const r3n = generateR3n(random, serverHash)
  const bchk = generateBchk()

  // Detected fonts (site-specific)
  const dffls = "Guardian-EgypTT,Graphik Webfont,ABCOtto,ABCDiatype"

  // Slight window size randomization
  const br_w = profile.br_w + Math.floor(random() * 100 - 50)
  const br_h = profile.br_h + Math.floor(random() * 100 - 50)
  const br_iw = br_w
  const br_ih = br_h

  // Build payload in exact signal order (matches tags.js collection)
  const payload: Record<string, unknown> = {}

  // Phase 1: log2
  payload.log2 = "gl,tzp"

  // Phase 2: r3n
  payload.r3n = r3n

  // Phase 3: WebGL
  payload.glvd = profile.glvd
  payload.glrd = profile.glrd

  // Phase 4: Cookie/session state
  payload.nddc = 1
  payload.exp8 = 0

  // Phase 5: Plugins
  payload.plu = profile.plu
  payload.plgod = profile.plgod
  payload.plg = profile.plg
  payload.plgne = profile.plgne
  payload.plgre = profile.plgre
  payload.plgof = profile.plgof
  payload.plggt = profile.plggt

  // Phase 6: Visibility / Window
  payload.bfr = false
  payload.hdn = false
  payload.br_w = br_w
  payload.br_h = br_h
  payload.br_iw = br_iw
  payload.br_ih = br_ih

  // Phase 7: Screen
  payload.ars_w = profile.ars_w
  payload.ars_h = profile.ars_h
  payload.rs_w = profile.rs_w
  payload.rs_h = profile.rs_h
  payload.rs_cd = profile.rs_cd

  // Phase 8: CSS client geometry
  payload.cg_w = profile.cg_w
  payload.cg_h = profile.cg_h
  payload.sg_w = profile.sg_w
  payload.sg_h = profile.sg_h

  // Phase 9: Pixel ratio & orientation
  payload.pr = profile.pr
  payload.so = profile.so

  // Phase 10: trrd
  payload.trrd = trrd

  // Phase 11: Override detection
  payload.ucdv = false
  payload.dp0 = false
  payload.hcovdr = false
  payload.plovdr = false
  payload.ftsovdr = false

  // Phase 12: Fonts
  payload.orf = ""
  payload.dffls = dffls

  // Phase 13: Network information
  payload.niet = profile.niet
  payload.nid = profile.nid
  payload.nisd = profile.nisd

  // Phase 14: Navigation timing
  Object.assign(payload, navTiming)

  // Phase 15: Language
  payload.lg = profile.lg

  // Phase 16: Iframe detection
  payload.isb = false
  payload.idp = true

  // Phase 17: requestIdleCallback
  payload.crt = 0

  // Phase 18: Vendor/bid
  payload.vnd = profile.vnd
  payload.bid = profile.bid

  // Phase 19: MediaDevices
  payload.med = profile.med

  // Phase 20: Permission/override checks
  payload.pltod = false
  payload.wdifrm = false
  payload.npmtm = false
  payload.wdif = false

  // Phase 21: Error stacks
  payload.ccsT = errorStacks.ccsT
  payload.ccsB = errorStacks.ccsB
  payload.ccsH = errorStacks.ccsH
  payload.ccsV = errorStacks.ccsV

  // Phase 22: MIME types
  payload.mmt = profile.mmt

  // Phase 23: wdifpnh
  payload.wdifpnh = wdifpnh

  // Phase 24: Video codecs
  Object.assign(payload, CHROME_VIDEO_CODECS)

  // Phase 25: CSS fingerprint
  payload.cssS = profile.cssS
  payload.css0 = profile.css0
  payload.css1 = profile.css1
  payload.cssH = profile.cssH
  payload.csssp = profile.csssp

  // Phase 26: Mouse events
  payload.muev = false

  // Phase 27: Feature detection
  Object.assign(payload, CHROME_FEATURES)

  // Phase 28: bchk
  payload.bchk = bchk

  // Phase 29: Timezone
  payload.tz = profile.tz

  // Phase 30: Hidden/Focus state
  payload.ihdn = false
  payload.cdhf = false

  // Phase 31: eva
  payload.eva = profile.eva

  // Phase 32: Chrome keys
  payload.cokys = profile.cokys

  // Phase 33: Process/opener
  payload.ecpc = false
  payload.wop = false

  // Phase 34: Navigator/UA data
  payload.pf = profile.pf
  payload.hc = profile.hc
  payload.br_oh = profile.br_oh
  payload.br_ow = profile.br_ow
  payload.ua = profile.ua
  payload.wbd = profile.wbd
  payload.ts_mtp = profile.ts_mtp
  payload.mob = profile.mob
  payload.lgs = profile.lgs
  payload.dvm = profile.dvm

  // Phase 35: Cookie writing
  payload.ckwa = true

  // Phase 36: Audio codecs
  Object.assign(payload, CHROME_AUDIO_CODECS)

  // Phase 37: Permissions
  payload.ocpt = false

  // Phase 38: Media queries
  payload.mq = "aptr:fine, ahvr:hover"
  payload.mq2 = "cg:srgb, dr:standard, dm:browser"

  // Phase 39: Bot detection
  Object.assign(payload, CHROME_BOT_CHECKS)

  // Phase 40: Navigator hardware info
  payload.nhi = profile.nhi

  // Phase 41: Keyboard layout
  payload.k_lyts = profile.k_lyts
  payload.k_lytk = profile.k_lytk

  // Phase 42: Barcode detection
  payload.bci = true
  payload.bcl = 1
  payload.bct = 0
  payload.bdt = null

  // Phase 43: Storage quota
  payload.stqe = profile.stqe
  payload.stqu = profile.stqu

  // Phase 44: Iframe detection flags
  payload.isf = false
  payload.isf2 = false

  // Phase 45: Automation detection
  payload.pw = false
  payload.pcb = false
  payload.arc = false
  payload.fai = false
  payload.gai = false
  payload.bbs3 = false

  // Phase 46: DevTools detection
  payload.dt = true

  // Phase 47: Fingerprint hash
  payload.fph = computeFph(profile)

  // Phase 48: Signal group checksums
  const checksums = computeChecksums(payload)
  payload.sgb = checksums.sgb
  payload.sgd = checksums.sgd
  payload.sgc = checksums.sgc

  // Phase 49: JS execution timestamp
  payload.jset = jset

  // Phase 50: Payload counter
  payload.bpc = 1

  return payload
}

// Build with random profile variations
export function buildPayloadWithVariation(
  url: string,
  hash: string,
  random: Random = Math.random,
): Record<string, unknown> {
  const profile = { ...CHROME_WIN_PROFILE }

  // Randomize some values
  const resolutions: [number, number][] = [
    [1920, 1080],
    [2560, 1440],
    [1680, 1050],
    [1440, 900],
  ]
  const [w, h] = resolutions[Math.floor(random() * resolutions.length)]
  profile.rs_w = w
  profile.rs_h = h
  profile.br_w = w
  profile.br_h = h - Math.floor(random() * 150 + 80)
  profile.br_iw = profile.br_w
  profile.br_ih = profile.br_h
  profile.ars_w = w
  profile.ars_h = h - Math.floor(random() * 50 + 40)
  profile.br_oh = profile.ars_h
  profile.br_ow = w

  // Randomize hardware concurrency
  profile.hc = [4, 6, 8, 12, 16][Math.floor(random() * 5)]

  // Randomize GPU
  const gpus = ["RTX 3060", "RTX 3070", "RTX 3080", "RTX 4070", "RTX 4080"]
  const gpu = gpus[Math.floor(random() * gpus.length)]
  profile.glrd = `ANGLE (NVIDIA, NVIDIA GeForce ${gpu} (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)`

  return buildPayload(profile, url, hash, random)
}
