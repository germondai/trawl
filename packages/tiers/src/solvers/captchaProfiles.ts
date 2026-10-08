import type { Page } from "patchright"
import { sleep } from "../utils/deadline"
import { captchaTask, validCaptchaTask } from "./captchaCatalog"

export type CaptchaInput =
  | { value: string | number | boolean | Record<string, unknown> | string[] }
  | { selector: string; attribute?: string; json?: boolean }
  | { source: "url" | "userAgent" | "cookies" | "html" }
  | { source: "screenshot"; selector: string }
  | { source: "global"; path: string[] }

export interface CaptchaProfile {
  hostname: string
  selector: string
  taskType: string
  inputs: Record<string, CaptchaInput>
  allowSessionData?: boolean
  delivery: {
    fields?: { selector: string; path: string[] }[]
    callback?: string
    callbackPath?: string[]
    cookies?: { name: string; path: string[]; format: "value" | "set-cookie" }[]
    reload?: boolean
    clicks?: {
      selector: string
      path: string[]
      mode: "grid" | "coordinates"
      imageInput?: string
      rows?: number
      columns?: number
    }
    submitSelector?: string
    verifySelector: string
  }
}

const safePath = (path: unknown): path is string[] =>
  Array.isArray(path) &&
  path.length <= 16 &&
  path.every(
    (key) => typeof key === "string" && key.length <= 256 && !["__proto__", "prototype", "constructor"].includes(key),
  )
const selector = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512
const callbackName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*$/.test(value) && safePath(value.split("."))
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function parseCaptchaProfiles(value: unknown): CaptchaProfile[] {
  if (!Array.isArray(value) || value.length > 64 || JSON.stringify(value).length > 256000)
    throw new Error("Invalid CAPTCHA_SOLVER_PROFILES configuration")
  for (const profile of value) {
    if (
      !object(profile) ||
      !selector(profile.selector) ||
      typeof profile.hostname !== "string" ||
      !/^[a-z0-9.-]+$/.test(profile.hostname) ||
      new URL(`https://${profile.hostname}`).hostname !== profile.hostname ||
      typeof profile.taskType !== "string" ||
      !captchaTask(profile.taskType) ||
      !object(profile.inputs) ||
      !object(profile.delivery)
    )
      throw new Error("Invalid CAPTCHA solver profile")
    const spec = captchaTask(profile.taskType)
    for (const [key, input] of Object.entries(profile.inputs)) {
      if (!spec || !Object.hasOwn(spec.fields, key) || !object(input)) throw new Error("Invalid CAPTCHA profile input")
      if (Object.hasOwn(input, "value")) {
        if (Object.keys(input).length !== 1 || input.value === null || typeof input.value === "undefined")
          throw new Error("Invalid CAPTCHA profile literal")
      } else if (input.source) {
        if (
          !["url", "userAgent", "cookies", "html", "screenshot", "global"].includes(String(input.source)) ||
          (input.source === "global" && !safePath(input.path)) ||
          (input.source === "screenshot" && !selector(input.selector))
        )
          throw new Error("Invalid CAPTCHA profile source")
        if (["cookies", "html"].includes(String(input.source)) && profile.allowSessionData !== true)
          throw new Error("CAPTCHA session data requires allowSessionData")
      } else if (
        !selector(input.selector) ||
        (input.attribute !== undefined && !selector(input.attribute)) ||
        (input.json !== undefined && typeof input.json !== "boolean")
      )
        throw new Error("Invalid CAPTCHA profile selector")
    }
    const delivery = profile.delivery
    if (
      !selector(delivery.verifySelector) ||
      (delivery.callback !== undefined && !callbackName(delivery.callback)) ||
      (delivery.callbackPath !== undefined && !safePath(delivery.callbackPath)) ||
      (delivery.reload !== undefined && typeof delivery.reload !== "boolean")
    )
      throw new Error("Invalid CAPTCHA profile delivery")
    if (!delivery.callback && !delivery.fields && !delivery.cookies && !delivery.clicks)
      throw new Error("CAPTCHA profile has no delivery method")
    if (delivery.submitSelector !== undefined && !selector(delivery.submitSelector))
      throw new Error("Invalid CAPTCHA submit selector")
    if (delivery.submitSelector && delivery.callback) throw new Error("Use a callback or submit selector, not both")
    if (delivery.clicks !== undefined) {
      const clicks = delivery.clicks
      if (
        !object(clicks) ||
        !selector(clicks.selector) ||
        !safePath(clicks.path) ||
        !["grid", "coordinates"].includes(String(clicks.mode))
      )
        throw new Error("Invalid CAPTCHA clicks")
      if (
        clicks.mode === "grid" &&
        ![clicks.rows, clicks.columns].every(
          (value) => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 20,
        )
      )
        throw new Error("Invalid CAPTCHA grid dimensions")
      if (
        clicks.mode === "coordinates" &&
        (typeof clicks.imageInput !== "string" || !Object.hasOwn(profile.inputs, clicks.imageInput))
      )
        throw new Error("CAPTCHA coordinates require an image input")
    }
    if (
      delivery.fields !== undefined &&
      (!Array.isArray(delivery.fields) ||
        !delivery.fields.length ||
        delivery.fields.length > 16 ||
        delivery.fields.some((field) => !object(field) || !selector(field.selector) || !safePath(field.path)))
    )
      throw new Error("Invalid CAPTCHA profile fields")
    if (
      delivery.cookies !== undefined &&
      (!Array.isArray(delivery.cookies) ||
        !delivery.cookies.length ||
        delivery.cookies.length > 16 ||
        delivery.cookies.some(
          (cookie) =>
            !object(cookie) ||
            typeof cookie.name !== "string" ||
            !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) ||
            !safePath(cookie.path) ||
            !["value", "set-cookie"].includes(String(cookie.format)),
        ))
    )
      throw new Error("Invalid CAPTCHA profile cookies")
  }
  return value as CaptchaProfile[]
}

export function solutionValue(solution: unknown, path: string[]): unknown {
  let value = solution
  for (const key of path) {
    if (!object(value) && !Array.isArray(value)) return undefined
    if (!Object.hasOwn(value, key) || ["__proto__", "prototype", "constructor"].includes(key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

export async function prepareCaptchaProfile(
  page: Page,
  profile: CaptchaProfile,
  proxyFields: Record<string, string | number>,
) {
  const url = new URL(page.url())
  if (url.hostname !== profile.hostname || !/^https?:$/.test(url.protocol) || url.username || url.password) return null
  const spec = captchaTask(profile.taskType)
  if (!spec) return null
  const hasProxy = Boolean(proxyFields.proxyType)
  if (
    (spec.proxy === "none" && hasProxy) ||
    (spec.proxy === "required" && !hasProxy) ||
    (spec.proxy === "optional" && (profile.taskType === spec.type) !== hasProxy)
  )
    return null
  const values = await page.evaluate((profile) => {
    if (document.querySelectorAll(profile.selector).length !== 1) return null
    const verified = document.querySelector(profile.delivery.verifySelector)
    if (verified instanceof HTMLElement && verified.getClientRects().length) return null
    if (profile.delivery.callback) {
      const marker = `data-trawl-${Math.random().toString(36).slice(2)}`
      const script = document.createElement("script")
      script.textContent = `try{const path=${JSON.stringify(profile.delivery.callback)}.split('.');let owner=window;for(const key of path.slice(0,-1))owner=owner[key];if(typeof owner[path[path.length-1]]==='function')document.documentElement.setAttribute(${JSON.stringify(marker)},'ok')}catch{}`
      document.documentElement.appendChild(script)
      script.remove()
      const callable = document.documentElement.getAttribute(marker) === "ok"
      document.documentElement.removeAttribute(marker)
      if (!callable) return null
    }
    const result: Record<string, unknown> = {}
    for (const [key, input] of Object.entries(profile.inputs)) {
      if ("value" in input) result[key] = input.value
      else if ("source" in input) {
        if (input.source === "url") result[key] = location.href
        if (input.source === "userAgent") result[key] = navigator.userAgent
        if (input.source === "html") result[key] = document.documentElement.outerHTML
        if (input.source === "global") {
          const marker = `data-trawl-${Math.random().toString(36).slice(2)}`
          const script = document.createElement("script")
          script.textContent = `try{let value=window;for(const key of ${JSON.stringify(input.path)}){if(value==null||!Object.hasOwn(value,key))throw Error();value=value[key]}const data=JSON.stringify(value);if(data&&data.length<=256000)document.documentElement.setAttribute(${JSON.stringify(marker)},data)}catch{}`
          document.documentElement.appendChild(script)
          script.remove()
          const data = document.documentElement.getAttribute(marker)
          document.documentElement.removeAttribute(marker)
          if (!data) return null
          try {
            result[key] = JSON.parse(data)
          } catch {
            return null
          }
        }
      } else {
        const elements = document.querySelectorAll(input.selector)
        const el = elements.length === 1 ? elements[0] : undefined
        if (!el) return null
        const value = input.attribute
          ? el.getAttribute(input.attribute)
          : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.value
            : el.textContent
        if (value === null || value === undefined || value.length > 2_000_000) return null
        try {
          result[key] = input.json ? JSON.parse(value) : value
        } catch {
          return null
        }
      }
    }
    // Validate all delivery targets before creating a paid task.
    const root = document.querySelector(profile.selector)
    for (const selector of [profile.delivery.clicks?.selector, profile.delivery.submitSelector].filter(
      Boolean,
    ) as string[]) {
      const targets = document.querySelectorAll(selector)
      const target = targets.length === 1 ? targets[0] : undefined
      if (
        !(target instanceof HTMLElement) ||
        !target.getClientRects().length ||
        !root ||
        (!root.contains(target) && (!root.closest("form") || target.closest("form") !== root.closest("form")))
      )
        return null
    }
    for (const field of profile.delivery.fields ?? []) {
      const els = document.querySelectorAll(field.selector)
      const el = els.length === 1 ? els[0] : undefined
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.value) return null
    }
    return result
  }, profile)
  if (!values) return null
  for (const [key, input] of Object.entries(profile.inputs)) {
    if (!("source" in input)) continue
    if (input.source === "cookies") {
      const cookies = await page.context().cookies(page.url())
      values[key] = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
    }
    if (input.source === "html" && key === "htmlPageBase64")
      values[key] = Buffer.from(String(values[key])).toString("base64")
    if (input.source === "screenshot") {
      const target = page.locator(input.selector)
      if ((await target.count()) !== 1) return null
      const body = await target.screenshot({ type: "png", timeout: 3000, animations: "disabled" })
      if (body.byteLength > 100000) return null
      values[key] = body.toString("base64")
    }
  }
  const task: Record<string, unknown> = { type: profile.taskType, ...values, ...proxyFields }
  if (Object.hasOwn(spec.fields, "websiteURL") && !task.websiteURL && !task.websiteUrl) task.websiteURL = page.url()
  if ((task.websiteURL && task.websiteURL !== page.url()) || (task.websiteUrl && task.websiteUrl !== page.url()))
    return null
  if (Object.hasOwn(spec.fields, "userAgent") && !task.userAgent)
    task.userAgent = await page.evaluate(() => navigator.userAgent)
  return validCaptchaTask(task) ? task : null
}

export async function deliverCaptchaProfile(
  page: Page,
  profile: CaptchaProfile,
  solution: unknown,
  signal: AbortSignal,
  task: Record<string, unknown> = {},
  remainingMs = 2000,
): Promise<boolean> {
  if (solution === null || solution === undefined || JSON.stringify(solution).length > 3_000_000) return false
  const fields = (profile.delivery.fields ?? []).map((field) => ({
    selector: field.selector,
    value: solutionValue(solution, field.path),
  }))
  if (fields.some((field) => typeof field.value !== "string" || !field.value || field.value.length > 65536))
    return false
  const callbackValue = profile.delivery.callback
    ? solutionValue(solution, profile.delivery.callbackPath ?? [])
    : undefined
  if (profile.delivery.callback && callbackValue === undefined) return false
  const cookies = (profile.delivery.cookies ?? []).map((cookie) => {
    const raw = solutionValue(solution, cookie.path)
    if (typeof raw !== "string" || !raw || raw.length > 4096 || /[\r\n]/.test(raw)) return null
    let value: string = raw
    if (cookie.format === "set-cookie") {
      const pair = value.split(";", 1)[0] ?? ""
      if (!pair.startsWith(`${cookie.name}=`)) return null
      value = pair.slice(cookie.name.length + 1)
    }
    if (!value || /[;\r\n]/.test(value)) return null
    return {
      name: cookie.name,
      value,
      url: page.url(),
      secure: page.url().startsWith("https://"),
      sameSite: "Lax" as const,
    }
  })
  if (cookies.some((cookie) => cookie === null)) return false
  const clicks = profile.delivery.clicks
  const positions: { x: number; y: number }[] = []
  if (clicks) {
    const target = page.locator(clicks.selector)
    if ((await target.count()) !== 1) return false
    const box = await target.boundingBox()
    const answer = solutionValue(solution, clicks.path)
    if (!box || box.width <= 0 || box.height <= 0 || !Array.isArray(answer) || !answer.length || answer.length > 32)
      return false
    if (clicks.mode === "grid") {
      const rows = clicks.rows ?? 0
      const columns = clicks.columns ?? 0
      for (const cell of answer) {
        if (!Number.isInteger(cell) || cell < 1 || cell > rows * columns) return false
        positions.push({
          x: box.x + ((((cell - 1) % columns) + 0.5) * box.width) / columns,
          y: box.y + ((Math.floor((cell - 1) / columns) + 0.5) * box.height) / rows,
        })
      }
    } else {
      const image = task[clicks.imageInput ?? ""]
      if (typeof image !== "string") return false
      const bytes = Buffer.from(image, "base64")
      if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return false
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      if (!width || !height) return false
      for (const coordinate of answer) {
        if (
          !object(coordinate) ||
          typeof coordinate.x !== "number" ||
          typeof coordinate.y !== "number" ||
          !Number.isFinite(coordinate.x) ||
          !Number.isFinite(coordinate.y) ||
          coordinate.x < 0 ||
          coordinate.y < 0 ||
          coordinate.x >= width ||
          coordinate.y >= height
        )
          return false
        positions.push({
          x: box.x + (coordinate.x * box.width) / width,
          y: box.y + (coordinate.y * box.height) / height,
        })
      }
    }
  }
  signal.throwIfAborted()
  const delivered = await page.evaluate(
    ({ profile, fields, callbackValue }) => {
      if (location.hostname !== profile.hostname || document.querySelectorAll(profile.selector).length !== 1)
        return false
      const targets: (HTMLInputElement | HTMLTextAreaElement)[] = []
      for (const field of fields) {
        const els = document.querySelectorAll(field.selector)
        const el = els.length === 1 ? els[0] : undefined
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.value) return false
        targets.push(el)
      }
      for (const [index, field] of fields.entries()) {
        const el = targets[index]
        if (!el) return false
        el.value = field.value as string
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
      }
      if (profile.delivery.callback) {
        const marker = `data-trawl-${Math.random().toString(36).slice(2)}`
        const script = document.createElement("script")
        script.textContent = `try { const path=${JSON.stringify(profile.delivery.callback)}.split('.'); let owner=window; for(const key of path.slice(0,-1)) owner=owner[key]; const fn=owner[path[path.length-1]]; if(typeof fn==='function'){fn.call(owner,${JSON.stringify(callbackValue)});document.documentElement.setAttribute(${JSON.stringify(marker)},'ok')}}catch{}`
        document.documentElement.appendChild(script)
        script.remove()
        const called = document.documentElement.getAttribute(marker) === "ok"
        document.documentElement.removeAttribute(marker)
        if (!called) {
          for (const el of targets) el.value = ""
          return false
        }
      }
      return true
    },
    { profile, fields, callbackValue },
  )
  if (!delivered || signal.aborted) return false
  for (const position of positions) {
    signal.throwIfAborted()
    await page.mouse.click(position.x, position.y)
  }
  if (profile.delivery.submitSelector) {
    signal.throwIfAborted()
    const submit = page.locator(profile.delivery.submitSelector)
    if ((await submit.count()) !== 1) return false
    await submit.click({ timeout: Math.min(3000, Math.max(1, remainingMs)) })
  }
  if (cookies.length) await page.context().addCookies(cookies.filter((cookie) => cookie !== null))
  signal.throwIfAborted()
  if (profile.delivery.reload) await page.reload({ waitUntil: "domcontentloaded", timeout: 5000 })
  const deadline = Date.now() + Math.max(0, remainingMs)
  while (!signal.aborted && Date.now() < deadline) {
    if (new URL(page.url()).hostname !== profile.hostname) return false
    if (
      await page.evaluate((selector) => {
        const els = document.querySelectorAll(selector)
        const el = els.length === 1 ? els[0] : undefined
        return el instanceof HTMLElement && Boolean(el.getClientRects().length)
      }, profile.delivery.verifySelector)
    )
      return true
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())), signal)
  }
  return false
}
