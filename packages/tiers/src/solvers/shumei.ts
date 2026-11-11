import * as jpeg from "jpeg-js"
import type { Page } from "patchright"
import { PNG } from "pngjs"
import { sleep } from "../utils/deadline"
import { desEncrypt } from "./shumeiCrypto"
import { analyzeClickCaptcha } from "./shumeiImage"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
const IMG_BASE = "https://castatic.fengkongcloud.cn"
const DISP_W = 294
const DISP_H = 147

interface ShumeiConfig {
  organization: string
  appId: string
  channel: string
  domain: string
  rversion: string
  sdkver: string
}

const DEFAULT_CONFIG: ShumeiConfig = {
  organization: "P9usCUBauxft8eAmUXaZ",
  appId: "default",
  channel: "default",
  domain: "captcha1.fengkongcloud.cn",
  rversion: "1.0.4",
  sdkver: "1.1.3",
}

function newUuid(): string {
  const now = new Date()
  const ts =
    now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, "0") +
    now.getDate().toString().padStart(2, "0") +
    now.getHours().toString().padStart(2, "0") +
    now.getMinutes().toString().padStart(2, "0") +
    now.getSeconds().toString().padStart(2, "0")
  return ts + Math.floor(10000 + Math.random() * 90000).toString()
}

function parseJsonp(text: string): unknown {
  const m = text.match(/^\s*[\w$.]+\s*\((.*)\)\s*;?\s*$/s)
  return JSON.parse(m ? m[1] : text)
}

async function jsonpGet(url: string, params: Record<string, string>): Promise<{ status: number; data: unknown }> {
  const cb = `sm_${Date.now()}${Math.floor(10 + Math.random() * 90)}`
  const qs = new URLSearchParams({ callback: cb, ...params })
  const res = await fetch(`${url}?${qs}`, {
    headers: { "User-Agent": UA, Referer: "https://example.com/" },
  })
  const text = await res.text()
  return { status: res.status, data: parseJsonp(text) }
}

interface RegisterResponse {
  code?: number
  riskLevel?: string
  detail?: {
    rid?: string
    bg?: string
    order?: string[]
    bg_width?: number
    bg_height?: number
  }
}

async function register(uuid: string, config: ShumeiConfig): Promise<RegisterResponse> {
  const url = `https://${config.domain}/ca/v1/register`
  const params = {
    organization: config.organization,
    lang: "zh-cn",
    model: "spatial_select",
    appId: config.appId,
    rversion: config.rversion,
    sdkver: config.sdkver,
    captchaUuid: uuid,
    channel: config.channel,
  }
  const { data } = await jsonpGet(url, params)
  return data as RegisterResponse
}

function buildVerifyBody(
  rid: string,
  uuid: string,
  selectData: [number, number, number][],
  dt: number,
  config: ShumeiConfig,
): Record<string, string> {
  return {
    organization: config.organization,
    vf: desEncrypt(config.appId, "3ae79dfa"),
    ri: desEncrypt(config.channel, "fa1b1f22"),
    cx: desEncrypt("zh-cn", "10c0600a"),
    is: desEncrypt("11", "53cda785"),
    rid,
    rversion: config.rversion,
    sdkver: config.sdkver,
    protocol: "210",
    ostype: "web",
    pe: desEncrypt(selectData, "e1024477"),
    yc: desEncrypt(selectData, "803d9d10"),
    xt: desEncrypt(dt, "e6c8d743"),
    qf: desEncrypt(DISP_W, "d809f47c"),
    qs: desEncrypt(DISP_H, "210a5a6d"),
    "act.os": "web",
    pr: desEncrypt("console", "f2858cfa"),
    vn: desEncrypt(false, "df29aa2d"),
    kh: desEncrypt(-1, "9728245c"),
    captchaUuid: uuid,
  }
}

interface VerifyResponse {
  code?: number
  riskLevel?: string
}

async function verify(body: Record<string, string>, config: ShumeiConfig): Promise<VerifyResponse> {
  const url = `https://${config.domain}/ca/v2/fverify`
  const { data } = await jsonpGet(url, body)
  return data as VerifyResponse
}

async function fetchImage(bgPath: string): Promise<{ pixels: Uint8Array; width: number; height: number } | undefined> {
  try {
    const res = await fetch(IMG_BASE + bgPath, { headers: { "User-Agent": UA } })
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())

    if (bgPath.endsWith(".jpg") || bgPath.endsWith(".jpeg")) {
      const img = jpeg.decode(buf, { useTArray: true })
      return { pixels: new Uint8Array(img.data), width: img.width, height: img.height }
    } else {
      const png = PNG.sync.read(buf)
      return { pixels: new Uint8Array(png.data), width: png.width, height: png.height }
    }
  } catch {
    return undefined
  }
}

export interface SolveShumeiResult {
  ok: boolean
  rid?: string
  uuid?: string
  attempts: number
  elapsed: number
  order?: string
}

export async function solveShumeiHttp(
  config: Partial<ShumeiConfig> = {},
  batch = 4,
  rounds = 3,
  sleepMs = 300,
): Promise<SolveShumeiResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const t0 = Date.now()
  let attempts = 0

  for (let rnd = 0; rnd < rounds; rnd++) {
    const uuids = Array.from({ length: batch }, () => newUuid())
    const tasks = await Promise.all(
      uuids.map(async (uuid) => {
        const reg = await register(uuid, cfg).catch(() => ({}) as RegisterResponse)
        const detail = reg.detail
        if (!detail?.rid || !detail?.bg) return undefined
        const img = await fetchImage(detail.bg)
        if (!img) return undefined
        return { uuid, rid: detail.rid, img, order: detail.order ?? [] }
      }),
    )

    const valid = tasks.filter((t): t is NonNullable<typeof t> => Boolean(t))
    if (valid.length === 0) continue

    const plans = valid
      .map((t) => {
        const analysis = analyzeClickCaptcha(t.img.pixels, t.img.width, t.img.height, t.order)
        if (!analysis.target) return undefined
        return {
          ...t,
          px: analysis.target.bx,
          py: analysis.target.by,
          W: analysis.width,
          H: analysis.height,
          orderText: t.order.join(" "),
        }
      })
      .filter((p): p is NonNullable<typeof p> => Boolean(p))

    for (const p of plans) {
      attempts++
      const now = Date.now()
      const xr = p.px / p.W
      const yr = p.py / p.H
      const selectData: [number, number, number][] = [[Math.round(xr * 1e6) / 1e6, Math.round(yr * 1e6) / 1e6, now]]
      const dt = Math.floor(800 + Math.random() * 19200)

      try {
        const body = buildVerifyBody(p.rid, p.uuid, selectData, dt, cfg)
        const resp = await verify(body, cfg)
        if (resp.riskLevel === "PASS") {
          return {
            ok: true,
            rid: p.rid,
            uuid: p.uuid,
            attempts,
            elapsed: Math.round((Date.now() - t0) / 100) / 10,
            order: p.orderText,
          }
        }
      } catch {}

      await sleep(sleepMs)
    }
  }

  return { ok: false, attempts, elapsed: Math.round((Date.now() - t0) / 100) / 10 }
}

export async function hasShumeiWidget(page: Page, timeoutMs = 3000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const POLL_INTERVAL = 300

  do {
    const detected = await page
      .evaluate(() => {
        return Boolean(document.querySelector(".shumei_captcha_wrapper.mode-spatial_select"))
      })
      .catch(() => false)
    if (detected) return true

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(POLL_INTERVAL, remaining), signal)
  } while (Date.now() < deadline)

  return false
}

async function extractShumeiConfig(page: Page): Promise<Partial<ShumeiConfig>> {
  return page
    .evaluate(() => {
      const config: Record<string, string> = {}
      const scripts = document.querySelectorAll("script")
      for (const s of scripts) {
        const text = s.textContent ?? ""
        const orgExpr = text.match(/organization\s*[=:]\s*([^,;}\n]+)/)?.[1]
        const orgKeys = orgExpr?.match(/["'][A-Za-z0-9]{20}["']/g)
        if (orgKeys) config.organization = orgKeys[orgKeys.length - 1].slice(1, -1)
        const appMatch = text.match(/appId\s*[=:]\s*["']([^"']+)["']/)
        if (appMatch) config.appId = appMatch[1]
        const channelMatch = text.match(/channel\s*[=:]\s*["']([^"']+)["']/)
        if (channelMatch) config.channel = channelMatch[1]
      }
      return config
    })
    .catch(() => ({}))
}

export async function solveShumei(page: Page, timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  const deadline = Date.now() + timeoutMs

  try {
    if (!(await hasShumeiWidget(page, Math.min(5000, timeoutMs), signal))) return false

    const pageConfig = await extractShumeiConfig(page)
    if (!pageConfig.organization) return false

    const remaining = Math.max(0, deadline - Date.now())
    const maxRounds = Math.ceil(remaining / 5000)
    const result = await solveShumeiHttp(pageConfig, 4, Math.min(maxRounds, 3))

    if (result.ok && result.rid) {
      console.log(`[shumei] solved in ${result.attempts} attempts, ${result.elapsed}s`)
      await page
        .evaluate((rid: string) => {
          const input = document.querySelector('input[name="smCaptcha"], input[name="captcha"]') as HTMLInputElement
          if (input) input.value = rid
          const event = new Event("shumei:solved", { bubbles: true })
          document.dispatchEvent(event)
        }, result.rid)
        .catch(() => {})
      return true
    }

    console.log(`[shumei] failed after ${result.attempts} attempts`)
    return false
  } catch (err) {
    console.log("[shumei] error:", err instanceof Error ? err.message : err)
    return false
  }
}
