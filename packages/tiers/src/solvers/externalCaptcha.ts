import type { Frame, Page } from "patchright"
import { RequestBudget, sleep } from "../utils/deadline"
import { captchaTask, detectExternalCaptchas } from "./captchaCatalog"
import { type CaptchaProfile, deliverCaptchaProfile, prepareCaptchaProfile } from "./captchaProfiles"

export interface ExternalCaptchaOptions {
  apiKey: string
  maxTasks: number
  timeoutMs: number
  localTimeoutMs: number
  profiles?: CaptchaProfile[]
}

const selectors = {
  "recaptcha-v2": ".g-recaptcha[data-sitekey]",
  "recaptcha-v2-enterprise": ".g-recaptcha[data-sitekey]",
  turnstile: ".cf-turnstile[data-sitekey]",
}
type SupportedCaptcha = keyof typeof selectors
const cooldowns = new WeakMap<ExternalCaptchaOptions, number>()

async function providerResponse(response: Response) {
  const length = Number(response.headers.get("content-length"))
  if (length > 512000 || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error("Invalid external solver response")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 512000) throw new Error("External solver response limit")
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function proxyFields(proxy?: string): Record<string, string | number> {
  if (!proxy) return {}
  const url = new URL(proxy)
  const proxyType = { "http:": "http", "socks4:": "socks4", "socks5:": "socks5" }[url.protocol]
  if (!proxyType) throw new Error("Unsupported external solver proxy protocol")
  const proxyPort = Number(url.port || (url.protocol === "http:" ? 80 : 1080))
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error("Invalid proxy port")
  return {
    proxyType,
    proxyAddress: url.hostname.replace(/^\[|\]$/g, ""),
    proxyPort,
    ...(url.username ? { proxyLogin: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { proxyPassword: decodeURIComponent(url.password) } : {}),
  }
}

async function readWidget(page: Page, type: SupportedCaptcha) {
  const widget = await page.evaluate((selector) => {
    // Explicitly rendered widgets and provider challenge pages need separate adapters.
    if (document.querySelector("#challenge-form")) return null
    const widgets = document.querySelectorAll<HTMLElement>(selector)
    if (widgets.length !== 1) return null
    const el = widgets[0]
    if (!el) return null
    const turnstile = selector.startsWith(".cf-")
    const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))
    if (
      scripts.some((script) => {
        const url = new URL(script.src)
        return (
          /\/recaptcha\/(api|enterprise)\.js$/.test(url.pathname) &&
          Boolean(url.searchParams.get("render")) &&
          url.searchParams.get("render") !== "explicit"
        )
      })
    )
      return null
    const compat = scripts.some((script) => {
      const url = new URL(script.src)
      return url.hostname === "challenges.cloudflare.com" && url.searchParams.get("compat") === "recaptcha"
    })
    const fieldName = turnstile
      ? el.getAttribute("data-response-field") === "false"
        ? null
        : (el.getAttribute("data-response-field-name") ?? (compat ? "g-recaptcha-response" : "cf-turnstile-response"))
      : "g-recaptcha-response"
    if (fieldName !== null && (!fieldName || fieldName.length > 256)) return null
    const fields = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"),
    ).filter((field) => field.name === fieldName)
    if (fields.length > 1 || (fields[0]?.value ?? "").length > 0) return null
    const field = fields[0]
    if (
      field &&
      (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ||
        (!el.contains(field) && (!el.closest("form") || field.closest("form") !== el.closest("form"))))
    )
      return null
    const sitekey = el.getAttribute("data-sitekey") ?? ""
    if (!sitekey || sitekey.length > 512) return null
    const callback = el.getAttribute("data-callback")
    if (
      callback &&
      (!/^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*$/.test(callback) ||
        /(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$)/.test(callback))
    )
      return null
    if (fieldName === null && !callback) return null
    if (callback) {
      const marker = `data-trawl-${Math.random().toString(36).slice(2)}`
      const script = document.createElement("script")
      script.textContent = `try{const path=${JSON.stringify(callback)}.split('.');let owner=window;for(const key of path.slice(0,-1))owner=owner[key];if(typeof owner[path[path.length-1]]==='function')document.documentElement.setAttribute(${JSON.stringify(marker)},'ok')}catch{}`
      document.documentElement.appendChild(script)
      script.remove()
      const callable = document.documentElement.getAttribute(marker) === "ok"
      document.documentElement.removeAttribute(marker)
      if (!callable) return null
    }
    const recaptchaUrl =
      document.querySelector<HTMLIFrameElement>('iframe[src*="recaptcha"][src*="anchor"]')?.src ??
      scripts.find((script) => /\/recaptcha\/(api|enterprise)\.js/.test(script.src))?.src
    const apiDomain =
      recaptchaUrl && /^(www\.)?recaptcha\.net$/.test(new URL(recaptchaUrl).hostname) ? "recaptcha.net" : "google.com"
    return {
      sitekey,
      enterprise: Boolean(document.querySelector('script[src*="recaptcha/enterprise"]')),
      callback,
      fieldName,
      apiDomain,
      userAgent: navigator.userAgent,
      invisible: el.getAttribute("data-size") === "invisible",
      dataS: el.getAttribute("data-s") ?? undefined,
      action: el.getAttribute("data-action") ?? undefined,
      data: el.getAttribute("data-cdata") ?? undefined,
    }
  }, selectors[type])
  if (
    widget &&
    !selectors[type].startsWith(".cf-") &&
    Boolean(widget.enterprise) !== (type === "recaptcha-v2-enterprise")
  )
    return null
  return widget
}

/** One allowance per scrape, shared across browser tiers and proxy attempts. */
export class ExternalCaptchaSession {
  private tasks = 0
  private detections = new Map<string, string>()

  private profile(kind: string): CaptchaProfile | undefined {
    if (!/^profile:\d+$/.test(kind)) return undefined
    return this.options.profiles?.[Number(kind.slice(8))]
  }

  diagnostics(): { kind: string; status: string }[] {
    return [...this.detections].map(([kind, status]) => ({ kind, status }))
  }

  label(kind: string): string {
    const profile = this.profile(kind)
    return profile ? (captchaTask(profile.taskType)?.kind ?? kind) : kind
  }

  async solveProfiles(page: Page, remainingMs: number, signal?: AbortSignal, proxy?: string): Promise<string[]> {
    const deadline = Date.now() + remainingMs
    const solved: string[] = []
    for (const kind of await this.discover(page)) {
      if (signal?.aborted || deadline - Date.now() <= 5000) break
      if (!(await this.canSolve(page, kind, proxy))) continue
      if (await this.solve(page, kind, deadline - Date.now(), signal, proxy))
        solved.push(`${this.label(kind)}:2captcha`)
    }
    return solved
  }

  async discover(page: Page, html?: string): Promise<string[]> {
    for (const kind of detectExternalCaptchas(html ?? (await page.content().catch(() => "")))) {
      if (!this.detections.has(kind))
        this.detections.set(kind, Object.hasOwn(selectors, kind) ? "detected" : "profile-required")
    }
    const ready: string[] = []
    for (const [index, profile] of (this.options.profiles ?? []).entries()) {
      if (new URL(page.url()).hostname !== profile.hostname) continue
      const kind = `profile:${index}`
      const present = await page
        .evaluate((selector) => document.querySelectorAll(selector).length === 1, profile.selector)
        .catch(() => false)
      if (present) ready.push(kind)
    }
    return ready
  }

  constructor(
    private readonly options: ExternalCaptchaOptions,
    private readonly fetcher: typeof fetch = fetch,
    private readonly pause: typeof sleep = sleep,
  ) {}

  supports(kind: string): boolean {
    return (
      (Object.hasOwn(selectors, kind) || Boolean(this.profile(kind))) &&
      this.tasks < this.options.maxTasks &&
      (cooldowns.get(this.options) ?? 0) <= Date.now()
    )
  }

  async canSolve(page: Page, kind: string, proxy?: string): Promise<boolean> {
    if (!this.supports(kind)) return false
    try {
      const url = new URL(page.url())
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false
      proxyFields(proxy)
      const profile = this.profile(kind)
      if (profile) {
        const task = await prepareCaptchaProfile(page, profile, proxyFields(proxy))
        this.detections.set(captchaTask(profile.taskType)?.kind ?? kind, task ? "ready" : "incomplete-profile")
        return Boolean(task)
      }
      return Boolean(await readWidget(page, kind as SupportedCaptcha))
    } catch {
      return false
    }
  }

  localBudget(remainingMs: number): number {
    return this.tasks < this.options.maxTasks
      ? Math.min(this.options.localTimeoutMs, Math.floor(remainingMs / 2))
      : remainingMs
  }

  async solve(page: Page, kind: string, remainingMs: number, signal?: AbortSignal, proxy?: string): Promise<boolean> {
    if (!this.supports(kind) || remainingMs <= 0 || signal?.aborted) return false
    const type = kind as SupportedCaptcha
    const budget = new RequestBudget(Math.min(remainingMs, this.options.timeoutMs))
    const navigation = new AbortController()
    const abort = AbortSignal.any([budget.signal, navigation.signal, ...(signal ? [signal] : [])])
    let delivering = false
    const state: { phase: "prepare" | "provider" | "delivery" } = { phase: "prepare" }
    const onNavigation = (frame: Frame) => {
      if (!delivering && frame === page.mainFrame()) navigation.abort()
    }
    let onAbort = () => {}
    const cancelled = new Promise<boolean>((resolve) => {
      onAbort = () => resolve(false)
      abort.addEventListener("abort", onAbort, { once: true })
      if (abort.aborted) onAbort()
    })
    page.on?.("framenavigated", onNavigation)
    try {
      const operation = budget.run(async () => {
        abort.throwIfAborted()
        const websiteURL = page.url()
        const parsedURL = new URL(websiteURL)
        if (!/^https?:$/.test(parsedURL.protocol) || parsedURL.username || parsedURL.password) return false
        const profile = this.profile(kind)
        const fields = proxyFields(proxy)
        const prepared = profile ? await prepareCaptchaProfile(page, profile, fields) : null
        const widget = profile ? null : await readWidget(page, type)
        if (profile && !prepared) return false
        if ((!profile && !widget) || abort.aborted || page.url() !== websiteURL) return false
        const taskType =
          type === "turnstile"
            ? "TurnstileTask"
            : type === "recaptcha-v2-enterprise"
              ? "RecaptchaV2EnterpriseTask"
              : "RecaptchaV2Task"
        const task = prepared ?? {
          type: `${taskType}${proxy ? "" : "Proxyless"}`,
          websiteURL,
          websiteKey: widget?.sitekey,
          ...fields,
          ...(type !== "turnstile"
            ? {
                isInvisible: widget?.invisible,
                ...(type === "recaptcha-v2-enterprise"
                  ? { enterprisePayload: widget?.dataS ? { s: widget.dataS } : undefined }
                  : { recaptchaDataSValue: widget?.dataS }),
                apiDomain: widget?.apiDomain,
                userAgent: widget?.userAgent,
              }
            : { action: widget?.action, data: widget?.data }),
        }
        const post = async (method: "createTask" | "getTaskResult", body: Record<string, unknown>) => {
          abort.throwIfAborted()
          const response = await this.fetcher(`https://api.2captcha.com/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            redirect: "error",
            signal: AbortSignal.any([abort, AbortSignal.timeout(Math.min(10_000, Math.max(1, budget.remaining())))]),
            body: JSON.stringify({ clientKey: this.options.apiKey, ...body }),
          }).catch(() => {
            if (method === "getTaskResult" && !abort.aborted) return null
            throw new Error("External solver transport failure")
          })
          if (response?.status === 429) cooldowns.set(this.options, Date.now() + 5000)
          if (!response || (method === "getTaskResult" && (response.status >= 500 || response.status === 429))) {
            await response?.body?.cancel().catch(() => {})
            return null
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            throw new Error("External solver HTTP failure")
          }
          const result = await providerResponse(response).catch(() => {
            if (method === "getTaskResult" && !abort.aborted) return null
            throw new Error("Invalid external solver response")
          })
          if (result === null && method === "getTaskResult") return null
          if (result?.errorId !== 0) {
            const delay =
              result?.errorCode === "ERROR_NO_SLOT_AVAILABLE"
                ? 5000
                : [
                      "ERROR_ZERO_BALANCE",
                      "ERROR_KEY_DOES_NOT_EXIST",
                      "ERROR_IP_NOT_ALLOWED",
                      "ERROR_IP_BLOCKED",
                      "ERROR_ACCOUNT_SUSPENDED",
                    ].includes(result?.errorCode)
                  ? 60000
                  : 0
            if (delay) cooldowns.set(this.options, Date.now() + delay)
            throw new Error("External solver rejected task")
          }
          return result
        }
        // There must be time for at least one provider poll before creating a paid task.
        if (budget.remaining() <= 5000) return false
        // A failed connection may still have created a paid task. Never retry creation.
        abort.throwIfAborted()
        if (!this.supports(type)) return false
        this.tasks++
        state.phase = "provider"
        const created = await post("createTask", { task })
        if (!created || !Number.isSafeInteger(created.taskId) || created.taskId <= 0) return false
        let pollFailures = 0
        while (!abort.aborted && budget.remaining() > 0) {
          if (budget.remaining() <= 5000) return false
          await this.pause(5000, abort)
          abort.throwIfAborted()
          const result = await post("getTaskResult", { taskId: created.taskId })
          if (result === null) {
            if (++pollFailures > 2) return false
            continue
          }
          pollFailures = 0
          if (result.status === "processing") continue
          if (result.status !== "ready") return false
          const returnedAgent =
            result.solution?.userAgent ??
            result.solution?.headers?.["User-Agent"] ??
            result.solution?.headers?.["user-agent"]
          if (returnedAgent !== undefined) {
            const browserAgent = await page.evaluate(() => navigator.userAgent)
            if (typeof returnedAgent !== "string" || returnedAgent !== browserAgent) {
              this.detections.set(this.label(kind), "identity-mismatch")
              return false
            }
          }
          if (profile) {
            const current = await prepareCaptchaProfile(page, profile, fields)
            if (
              abort.aborted ||
              page.url() !== websiteURL ||
              !current ||
              JSON.stringify(current) !== JSON.stringify(prepared)
            )
              return false
            delivering = true
            state.phase = "delivery"
            const accepted = await deliverCaptchaProfile(
              page,
              profile,
              result.solution,
              abort,
              current,
              budget.remaining(),
            )
            this.detections.set(captchaTask(profile.taskType)?.kind ?? kind, accepted ? "verified" : "delivery-failed")
            return accepted
          }
          if (!widget) return false
          const token = type === "turnstile" ? result.solution?.token : result.solution?.gRecaptchaResponse
          if (typeof token !== "string" || !token.trim() || token.length > 65536 || page.url() !== websiteURL)
            return false
          const currentWidget = await readWidget(page, type)
          if (!currentWidget || JSON.stringify(currentWidget) !== JSON.stringify(widget)) return false
          abort.throwIfAborted()
          delivering = true
          state.phase = "delivery"
          return await page.evaluate(
            ({ selector, sitekey, token, callback, websiteURL, fieldName }) => {
              if (location.href !== websiteURL) return false
              const widgets = document.querySelectorAll<HTMLElement>(selector)
              const el = widgets.length === 1 ? widgets[0] : undefined
              if (!el || el.getAttribute("data-sitekey") !== sitekey || el.getAttribute("data-callback") !== callback)
                return false
              const fields = Array.from(
                document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"),
              ).filter((field) => field.name === fieldName)
              if (fields.length > 1 || (fields[0]?.value ?? "").length > 0) return false
              const existing = fields[0]
              if (
                existing &&
                (!(existing instanceof HTMLInputElement || existing instanceof HTMLTextAreaElement) ||
                  (!el.contains(existing) && (!el.closest("form") || existing.closest("form") !== el.closest("form"))))
              )
                return false
              const field = fieldName === null ? undefined : (fields[0] ?? document.createElement("textarea"))
              if (field && !fields.length) {
                field.name = fieldName as string
                field.hidden = true
                el.appendChild(field)
              }
              if (field) {
                field.value = token
                field.dispatchEvent(new Event("input", { bubbles: true }))
                field.dispatchEvent(new Event("change", { bubbles: true }))
              }
              if (!callback && field?.value !== token) return false
              if (callback) {
                // Run the named callback in the page's realm, not Firefox's isolated world.
                // A page CSP may refuse this script; in that case do not report completion.
                const marker = `data-trawl-${Math.random().toString(36).slice(2)}`
                const script = document.createElement("script")
                script.textContent = `try {
                const path = ${JSON.stringify(callback)}.split('.');
                let owner = window;
                for (const part of path.slice(0, -1)) owner = owner[part];
                const fn = owner[path[path.length - 1]];
                if (typeof fn === 'function') { fn.call(owner, ${JSON.stringify(token)}); document.documentElement.setAttribute(${JSON.stringify(marker)}, 'ok'); }
              } catch {}`
                document.documentElement.appendChild(script)
                script.remove()
                const called = document.documentElement.getAttribute(marker) === "ok"
                document.documentElement.removeAttribute(marker)
                if (!called) {
                  if (field) field.value = ""
                  if (!fields.length) field?.remove()
                  return false
                }
              }
              return true
            },
            {
              selector: selectors[type],
              sitekey: widget.sitekey,
              token,
              callback: widget.callback,
              fieldName: widget.fieldName,
              websiteURL,
            },
          )
        }
        return false
      })
      const completed = await Promise.race([operation, cancelled])
      const label = this.label(kind)
      if (!completed && !["delivery-failed", "identity-mismatch"].includes(this.detections.get(label) ?? ""))
        this.detections.set(label, abort.aborted ? "cancelled" : "not-delivered")
      if (completed && !this.profile(kind)) this.detections.set(label, "delivered")
      return completed
    } catch {
      // Provider descriptions can contain request data; keep them out of logs and API errors.
      this.detections.set(
        this.label(kind),
        abort.aborted
          ? "cancelled"
          : state.phase === "delivery"
            ? "delivery-failed"
            : state.phase === "prepare"
              ? "not-prepared"
              : "provider-failed",
      )
      return false
    } finally {
      abort.removeEventListener("abort", onAbort)
      page.off?.("framenavigated", onNavigation)
      budget.dispose()
    }
  }
}
