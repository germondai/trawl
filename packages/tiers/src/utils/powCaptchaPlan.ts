import { parseHTML } from "linkedom"
import { type AltchaChallenge, solveAltcha } from "../solvers/altchaPow"
import { fetchAndSolveFriendlyCaptcha, solveFriendlyCaptchaV1 } from "../solvers/friendlyCaptchaPow"
import { hasChallengeWallMarkers, isChallengeWall } from "./detect"
import type { PowPlan } from "./nativePow"

export function planPowCaptcha(
  html: string,
  pageUrl: string,
  statusCode = 200,
  fetchJson?: (url: string) => Promise<unknown>,
): PowPlan | undefined {
  if (html.length > 262_144 || !/altcha-widget|frc-captcha/i.test(html)) return
  try {
    const { document } = parseHTML(html)
    const widgets = [...document.querySelectorAll("altcha-widget, .frc-captcha")].filter(
      (node) => !node.closest("template, noscript, pre, code"),
    )
    if (widgets.length !== 1 || document.querySelectorAll("form").length !== 1) return
    const widget = widgets[0]
    const kind = widget.tagName === "ALTCHA-WIDGET" ? "altcha" : "friendly-captcha"
    // Embedded application forms must keep their browser lifecycle and callbacks.
    if (
      !isChallengeWall(statusCode, html.length, kind, html) ||
      !hasChallengeWallMarkers(`<title>${document.title}</title>`)
    )
      return
    const form = widget.closest("form")
    if (
      form?.getAttribute("method")?.toUpperCase() !== "POST" ||
      !["altcha-form", "captcha-form", "friendly-captcha-form"].includes(form.id) ||
      form.querySelector("textarea, select, [formaction], [formmethod]") ||
      document.querySelector("[form]")
    )
      return
    const inputs = [...form.querySelectorAll("input")]
    if (inputs.some((input) => input.getAttribute("type")?.toLowerCase() !== "hidden")) return
    if (
      [...form.querySelectorAll("button")].some(
        (button) => button.hasAttribute("name") || (button.getAttribute("type") ?? "submit").toLowerCase() !== "submit",
      )
    )
      return
    if (
      [form, ...form.querySelectorAll("*")].some((node) =>
        [...node.attributes].some((attribute) => /^on|callback/i.test(attribute.name)),
      )
    )
      return
    const url = new URL(form.getAttribute("action") || pageUrl, pageUrl)
    if (!/^https?:$/.test(url.protocol) || url.origin !== new URL(pageUrl).origin || url.username || url.password)
      return
    if (document.querySelector("base[href]")) return
    const fields = new URLSearchParams()
    for (const input of inputs) {
      const name = input.getAttribute("name")
      if (name && !input.hasAttribute("disabled")) fields.append(name, input.getAttribute("value") ?? "")
    }
    let fieldName: string
    let solve: (timeoutMs?: number, signal?: AbortSignal) => Promise<string | undefined>
    if (kind === "altcha") {
      fieldName = widget.getAttribute("name") || "altcha"
      const json = widget.getAttribute("challengejson")
      const challengeUrl = widget.getAttribute("challengeurl")
      if (!json && (!challengeUrl || !fetchJson)) return
      const challenge = json ? (JSON.parse(json) as AltchaChallenge) : undefined
      solve = async (timeoutMs = 1000, signal) => {
        const deadline = Date.now() + timeoutMs
        if (signal?.aborted || timeoutMs <= 0) return
        const input =
          challenge ??
          ((await fetchJson?.(new URL(challengeUrl as string, pageUrl).href)) as AltchaChallenge | undefined)
        if (!input) return
        return solveAltcha(input, deadline - Date.now(), signal)
      }
    } else {
      if (document.querySelector('script[src*="frcapi.com"], script[src*="@friendlycaptcha/sdk"]')) return
      const puzzle = widget.getAttribute("data-puzzle")
      const sitekey = widget.getAttribute("data-sitekey")
      const response = inputs.find((input) => input.getAttribute("name") === "frc-captcha-solution")
      if (!response || (!puzzle && (!sitekey || !fetchJson))) return
      fieldName = response.getAttribute("name") as string
      solve = async (timeoutMs = 1000, signal) => {
        if (puzzle) return (await solveFriendlyCaptchaV1(puzzle, timeoutMs, signal))?.response
        const endpoint = new URL(
          widget.getAttribute("data-puzzle-endpoint") || "https://api.friendlycaptcha.com/api/v1/puzzle",
          pageUrl,
        ).href
        return (
          await fetchAndSolveFriendlyCaptcha(
            sitekey as string,
            fetchJson as (url: string) => Promise<unknown>,
            timeoutMs,
            signal,
            endpoint,
          )
        )?.response
      }
    }
    return {
      kind,
      waitMs: 0,
      submit: async (timeoutMs, signal) => {
        const value = await solve(timeoutMs, signal)
        if (!value || signal?.aborted) return
        const body = new URLSearchParams(fields)
        body.set(fieldName, value)
        return {
          url: url.href,
          method: "POST",
          contentType: "application/x-www-form-urlencoded",
          body: body.toString(),
        }
      },
    }
  } catch {
    return
  }
}
