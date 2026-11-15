// DataDome token fetcher via direct API call.
//
// Instead of solving the widget, this posts fabricated fingerprint and event data to DataDome's
// JS endpoint, mimicking what their client-side script does. The response carries a `datadome`
// cookie that may grant access without ever showing the wall.
//
// This is a bypass, not a solver: the data is synthetic. It works when the fingerprint is not
// yet flagged, but DataDome will rotate detection over time.

import type { Page } from "patchright"

const DD_ENDPOINT = "https://api-js.datadome.co/js/"
const DD_VERSION = "4.30.0"

type Random = () => number

interface JsData {
  [key: string]: string | number | boolean | null
}

function randomInt(min: number, max: number, random: Random): number {
  return Math.floor(min + random() * (max - min + 1))
}

function randomHex(length: number, random: Random): string {
  const chars = "0123456789abcdef"
  return Array.from({ length }, () => chars[Math.floor(random() * 16)]).join("")
}

// Fabricated browser fingerprint, styled after the Go implementation. The values are plausible
// for a desktop Chrome on Windows but static: DataDome may eventually flag them.
function buildJsData(referer: string, random: Random): JsData {
  const width = [1920, 2560, 1680, 1440][randomInt(0, 3, random)]
  const height = width === 1920 ? 1080 : width === 2560 ? 1440 : width === 1680 ? 1050 : 900
  const now = Date.now()

  return {
    ttst: randomInt(20, 80, random) + random() * 10,
    ifov: false,
    tagpu: randomInt(15, 40, random) + random() * 5,
    glvd: "Google Inc. (NVIDIA)",
    glrd: `ANGLE (NVIDIA, NVIDIA GeForce RTX ${[3060, 3070, 3080, 4070, 4080][randomInt(0, 4, random)]} Direct3D11 vs_5_0 ps_5_0, D3D11)`,
    hc: navigator?.hardwareConcurrency ?? randomInt(8, 16, random),
    br_oh: height,
    br_ow: width,
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    wbd: false,
    wdif: false,
    wdifrm: false,
    npmtm: false,
    br_h: height - randomInt(70, 120, random),
    br_w: width,
    nddc: 1,
    rs_h: height,
    rs_w: width,
    rs_cd: 24,
    phe: false,
    nm: false,
    jsf: false,
    lg: "en-US",
    pr: 1,
    ars_h: height - randomInt(40, 50, random),
    ars_w: width,
    tz: -new Date().getTimezoneOffset(),
    str_ss: true,
    str_ls: true,
    str_idb: true,
    str_odb: true,
    plgod: false,
    plg: 5,
    plgne: true,
    plgre: true,
    plgof: false,
    plggt: false,
    pltod: false,
    hcovdr: false,
    hcovdr2: false,
    plovdr: false,
    plovdr2: false,
    ftsovdr: false,
    ftsovdr2: false,
    lb: false,
    eva: 33,
    lo: false,
    ts_mtp: 0,
    ts_tec: false,
    ts_tsa: false,
    vnd: "Google Inc.",
    bid: "NA",
    mmt: "application/pdf,text/pdf",
    plu: "PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF",
    hdn: false,
    apts: true,
    te_t: true,
    tz_ofs: -new Date().getTimezoneOffset(),
    sc_r: Math.random() > 0.5 ? 2 : 1,
    sc_h: height,
    sc_w: width,
    sc_d: 24,
    wr: width,
    hr: height,
    wh: 0,
    owe: true,
    cpc: false,
    mrc: false,
    emt: false,
    ewp: true,
    wwl: false,
    rp: randomInt(50, 150, random),
    ssp: 1,
    dkp: 1,
    rvp: 1,
    sop: 0,
    asp: 0,
    dcr: "new",
    srt: now - randomInt(500, 2000, random),
    crt: now,
    prt: now + randomInt(10, 50, random),
    ref: referer,
    wl: 0,
    np: 0,
    fc: 0,
    foc: 0,
    cn1: 0,
    cn2: 0,
    mp_cx: randomInt(300, 800, random),
    mp_cy: randomInt(200, 500, random),
    mp_tr: true,
    mp_mx: randomInt(100, 600, random),
    mp_my: randomInt(100, 400, random),
    mp_sx: 0,
    mp_sy: 0,
    mm_md: randomInt(100, 300, random),
    mm_mc: randomInt(20, 60, random),
    mm_ml: randomInt(500, 1500, random),
    vcr: null,
    vc: null,
    vc1: null,
    vc2: null,
    vc3: null,
    vc4: null,
    vc5: null,
    vc6: null,
    vc7: null,
    vc8: null,
    vc9: null,
    vca: null,
    vcb: null,
    vcc: null,
    vcd: null,
    vce: null,
    vcf: null,
    acc: "probably",
    acm: "maybe",
    aco: "probably",
    acf: "probably",
    acw: "probably",
    am: "maybe",
    ao: "probably",
    av: "probably",
    vco: "probably",
    vcm: "maybe",
    vcv: "probably",
    vcw: "probably",
    vca2: "probably",
    vcm2: "maybe",
    vcv2: "probably",
    vcw2: "probably",
    dvm: 8,
    sqt: false,
    so: "landscape-primary",
    wdw: true,
    cokys: "bG9hZFRpbWVzY3NpYXBwL=",
    ecpc: false,
    lgs: true,
    lgsod: false,
    bcda: false,
    bcdb: false,
    bcdc: true,
    bcdd: true,
    bcde: true,
    bcdf: true,
    dtefh: `h${randomHex(32, random)}==`,
  }
}

// Synthetic mouse and scroll events, timed against now. A real user would have these from moving
// around the page before the wall appeared.
function buildEvents(random: Random): Array<{ source: { x: number; y: number }; message: string; date: number }> {
  const now = Date.now()
  const base = now - randomInt(3000, 8000, random)
  return [
    { source: { x: randomInt(100, 400, random), y: randomInt(100, 300, random) }, message: "scroll", date: base },
    {
      source: { x: randomInt(200, 600, random), y: randomInt(150, 400, random) },
      message: "mouse move",
      date: base + randomInt(200, 600, random),
    },
    {
      source: { x: randomInt(300, 700, random), y: randomInt(200, 450, random) },
      message: "mouse move",
      date: base + randomInt(800, 1400, random),
    },
    {
      source: { x: randomInt(400, 800, random), y: randomInt(250, 500, random) },
      message: "scroll",
      date: base + randomInt(1600, 2200, random),
    },
  ]
}

function buildEventCounters(random: Random): Record<string, number> {
  return {
    mouse_move: randomInt(30, 80, random),
    mouse_click: randomInt(2, 8, random),
    scroll: randomInt(5, 20, random),
    touch_start: 0,
    touch_end: 0,
    touch_move: 0,
    key_down: 0,
    key_up: 0,
  }
}

export interface TokenResult {
  cookie?: string
  error?: string
}

// Extract the cid (challenge ID) from a DataDome captcha URL.
function extractCid(captchaUrl: string): string | undefined {
  try {
    return new URL(captchaUrl).searchParams.get("cid") ?? undefined
  } catch {
    return undefined
  }
}

// Posts the fingerprint to DataDome's endpoint and extracts the cookie from the response.
export async function fetchDataDomeToken(
  page: Page,
  options: {
    // The captcha URL (carries the cid) or the cid directly.
    captchaUrl?: string
    cid?: string
    // The ddk (DataDome key) for the site. Required.
    ddk: string
    // The site's origin, e.g. "https://www.example.com".
    origin: string
    // The page the user was on when the wall appeared.
    referer?: string
    timeoutMs?: number
  },
  random: Random = Math.random,
): Promise<TokenResult> {
  const cid = options.cid ?? (options.captchaUrl ? extractCid(options.captchaUrl) : undefined)
  if (!cid) return { error: "no cid" }

  const referer = options.referer ?? options.origin
  const jsData = buildJsData(referer, random)
  const events = buildEvents(random)
  const eventCounters = buildEventCounters(random)

  const body = new URLSearchParams({
    jsData: JSON.stringify(jsData),
    events: JSON.stringify(events),
    eventCounters: JSON.stringify(eventCounters),
    jsType: random() > 0.5 ? "le" : "ch",
    cid,
    ddk: options.ddk,
    Referer: referer,
    request: new URL(referer).pathname,
    responsePage: "origin",
    ddv: DD_VERSION,
  })

  try {
    const response = await page.request.post(DD_ENDPOINT, {
      data: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*",
        Origin: options.origin,
        Referer: referer,
        "User-Agent": jsData.ua as string,
      },
      timeout: options.timeoutMs ?? 10_000,
    })

    if (!response.ok()) {
      return { error: `http ${response.status()}` }
    }

    const json = await response.json().catch(() => null)
    if (!json || typeof json !== "object") {
      return { error: "invalid response" }
    }

    const raw = (json as { cookie?: string }).cookie
    if (!raw || typeof raw !== "string") {
      return { error: "no cookie in response" }
    }

    // The response is "datadome=<value>; ..." — extract just the value.
    const match = /^datadome=([^;]+)/.exec(raw)
    return match ? { cookie: match[1] } : { error: "malformed cookie" }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// Applies the fetched token as a cookie on the page's context.
export async function applyDataDomeToken(page: Page, token: string, domain: string): Promise<void> {
  await page.context().addCookies([
    {
      name: "datadome",
      value: token,
      domain,
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    },
  ])
}
