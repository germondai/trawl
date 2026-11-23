import type { Page } from "patchright"
import { solveAwsWaf } from "../solvers/awsWaf"
import { solveDataDome } from "../solvers/datadome"
import { hasWallFrame } from "../solvers/datadomeWidget"
import type { ExternalCaptchaSession } from "../solvers/externalCaptcha"
import { waitForAkamaiResolution } from "./akamaiWait"
import { type AnubisResolution, waitForAnubisResolution } from "./anubisWait"
import { type AwsWafResolution, waitForAwsWafResolution } from "./awsWafWait"
import type { CaptchaSink } from "./captchaOutcomes"
import { waitForChallengeResolution } from "./challengeWait"
import type { ChallengeCookieSnapshot } from "./cookies"
import { type DataDomeResolution, waitForDataDomeResolution } from "./datadomeWait"
import { waitForDdosGuardResolution } from "./ddosGuardWait"
import { sleep } from "./deadline"
import {
  type ChallengeType,
  detectChallengeType,
  getAwsWafAction,
  getDataDomeAction,
  hasAwsWafCaptcha,
  isCloudflareErrorUrl,
  isCloudflarePage,
} from "./detect"
import { waitForImpervaResolution } from "./impervaWait"

type Resolution = AwsWafResolution | DataDomeResolution | AnubisResolution
type Waiter = (page: Page, timeoutMs: number, originalUrl?: string) => Promise<Resolution>

interface ChallengeWaiters {
  cloudflare: (
    page: Page,
    timeoutMs: number,
    originalUrl?: string,
    responseHeaders?: () => Record<string, string>,
  ) => Promise<Resolution>
  imperva: Waiter
  akamai: Waiter
  ddosGuard: Waiter
  awsWaf: (
    page: Page,
    timeoutMs: number,
    originalUrl?: string,
    initialTokens?: ReadonlySet<string>,
    signal?: AbortSignal,
  ) => Promise<Resolution>
  dataDome: (
    page: Page,
    timeoutMs: number,
    originalUrl?: string,
    initialCookies?: ReadonlySet<string>,
    signal?: AbortSignal,
  ) => Promise<Resolution>
  // Optional so callers and tests that build their own waiter set never reach a real page.
  awsWafCaptcha?: (page: Page, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>
  dataDomeCaptcha?: (page: Page, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>
}

const defaultWaiters: ChallengeWaiters = {
  awsWafCaptcha: solveAwsWaf,
  dataDomeCaptcha: solveDataDome,
  cloudflare: waitForChallengeResolution,
  imperva: waitForImpervaResolution,
  akamai: waitForAkamaiResolution,
  ddosGuard: waitForDdosGuardResolution,
  awsWaf: (page, timeoutMs, originalUrl, initialTokens, signal) =>
    waitForAwsWafResolution(page, timeoutMs, originalUrl, { initialTokens, signal }),
  dataDome: (page, timeoutMs, originalUrl, initialCookies, signal) =>
    waitForDataDomeResolution(page, timeoutMs, originalUrl, { initialCookies, signal }),
}

async function routeLocalChallengeWait(
  page: Page,
  html: string,
  headers: Record<string, string>,
  timeoutMs: number,
  originalUrl?: string,
  waiters: ChallengeWaiters = defaultWaiters,
  status?: number,
  initialCookies?: ChallengeCookieSnapshot,
  responseHeaders: () => Record<string, string> = () => headers,
): Promise<{ challengeType: ChallengeType; resolution: Resolution }> {
  const challengeType = detectChallengeType(html, headers, status)
  if (getAwsWafAction(status, headers) === "captcha" || hasAwsWafCaptcha(html)) {
    return { challengeType: "aws-waf", resolution: "captcha-required" }
  }
  // DuckDuckGo's anomaly wall is an interactive image puzzle, not a silent
  // challenge that resolves by waiting or by attempting Cloudflare controls.
  if (challengeType === "duckduckgo") return { challengeType, resolution: "captcha-required" }
  // Provider widgets are solved after routing by solvePageCaptchas(). They are
  // page content, not interstitial walls, so never send them through a WAF waiter.
  if (
    challengeType === "altcha" ||
    challengeType === "friendly-captcha" ||
    ((challengeType === "cloudflare-turnstile" ||
      challengeType === "recaptcha" ||
      challengeType === "hcaptcha" ||
      challengeType === "cap" ||
      challengeType === "shumei" ||
      challengeType === "baxia") &&
      !isCloudflarePage(html, headers))
  ) {
    return { challengeType, resolution: "ok" }
  }
  // Anubis resolves itself in the browser (PoW or metarefresh, then re-navigation) and
  // has no interactive widget.
  if (challengeType === "anubis") {
    return { challengeType, resolution: await waitForAnubisResolution(page, timeoutMs) }
  }
  // Neither the DataDome slider nor its hard block resolves by waiting, so they never reach
  // a waiter: report them straight away and let the tier escalate.
  if (challengeType === "datadome") {
    const action = getDataDomeAction(html, headers, status)
    if (action === "captcha") return { challengeType, resolution: "captcha-required" }
    if (action === "blocked") return { challengeType, resolution: "ip-blocked" }
  }
  const resolution =
    challengeType === "imperva"
      ? await waiters.imperva(page, timeoutMs, originalUrl)
      : challengeType === "akamai"
        ? await waiters.akamai(page, timeoutMs, originalUrl)
        : challengeType === "ddos-guard"
          ? await waiters.ddosGuard(page, timeoutMs, originalUrl)
          : challengeType === "aws-waf"
            ? await waiters.awsWaf(page, timeoutMs, originalUrl, initialCookies?.awsWaf)
            : challengeType === "datadome"
              ? await waiters.dataDome(page, timeoutMs, originalUrl, initialCookies?.dataDome)
              : await waiters.cloudflare(page, timeoutMs, originalUrl, responseHeaders)
  return { challengeType, resolution }
}

export async function routeChallengeWait(
  page: Page,
  html: string,
  headers: Record<string, string>,
  timeoutMs: number,
  originalUrl?: string,
  waiters: ChallengeWaiters = defaultWaiters,
  status?: number,
  initialCookies?: ChallengeCookieSnapshot,
  responseHeaders: () => Record<string, string> = () => headers,
  external?: ExternalCaptchaSession,
  proxy?: string,
  signal?: AbortSignal,
  onCaptcha?: CaptchaSink,
  responseStatus: () => number | undefined = () => undefined,
): Promise<{ challengeType: ChallengeType; resolution: Resolution; captchasSolved?: string[] }> {
  const deadline = Date.now() + timeoutMs
  let eligible = false
  let managedCloudflare = false
  if (external) {
    for (const kind of await external.discover(page, html)) {
      if (signal?.aborted) break
      if (kind === "cloudflare-challenge" && external.supports(kind)) {
        managedCloudflare = true
        eligible = true
      } else if (await external.canSolve(page, kind, proxy)) eligible = true
    }
  }
  let result = await routeLocalChallengeWait(
    page,
    html,
    headers,
    eligible && external
      ? external.localBudget(Math.max(0, deadline - Date.now()))
      : Math.max(0, deadline - Date.now()),
    originalUrl,
    waiters,
    status,
    initialCookies,
    responseHeaders,
  )
  // An interactive CAPTCHA wall is solved through its audio puzzle. A solved wall reloads the
  // page itself, so wait for it to leave the wall before asking the waiter to confirm the
  // new token or cookie; otherwise the waiter would still see the CAPTCHA markup and report it.
  const wallSolver =
    result.resolution === "captcha-required" && !signal?.aborted && deadline > Date.now()
      ? result.challengeType === "aws-waf" && waiters.awsWafCaptcha
        ? {
            type: "aws-waf" as const,
            solve: waiters.awsWafCaptcha,
            stillWall: (html: string) => hasAwsWafCaptcha(html),
            confirm: (timeout: number) => waiters.awsWaf(page, timeout, originalUrl, initialCookies?.awsWaf, signal),
          }
        : result.challengeType === "datadome" && waiters.dataDomeCaptcha
          ? {
              type: "datadome" as const,
              solve: waiters.dataDomeCaptcha,
              stillWall: (html: string) => getDataDomeAction(html) === "captcha",
              confirm: (timeout: number) =>
                waiters.dataDome(page, timeout, originalUrl, initialCookies?.dataDome, signal),
            }
          : undefined
      : undefined
  if (wallSolver) {
    // With an external solver configured the local attempt gets only its share, like every
    // other local solver, so the fallback is not left without time.
    const available = Math.max(0, deadline - Date.now())
    const localTimeout = eligible && external ? external.localBudget(available) : available
    const localDeadline = Math.min(deadline, Date.now() + localTimeout)
    const solvedWall = await wallSolver.solve(page, localTimeout, signal).catch(() => false)
    if (solvedWall && !signal?.aborted) {
      const clearUntil = Math.min(localDeadline, Date.now() + 8_000)
      while (Date.now() < clearUntil && !signal?.aborted) {
        const current = await page.content().catch(() => "")
        if (current && !wallSolver.stillWall(current)) break
        await sleep(Math.min(250, Math.max(0, clearUntil - Date.now())), signal).catch(() => {})
      }
      if (signal?.aborted) {
        onCaptcha?.([{ kind: wallSolver.type, outcome: "failed" }])
        return result
      }
      let resolution = await wallSolver.confirm(Math.max(0, localDeadline - Date.now()))
      if (wallSolver.type === "datadome" && resolution === "ok" && !signal?.aborted) {
        const current = await page.content().catch(() => "")
        const action = getDataDomeAction(current, responseHeaders(), responseStatus())
        if ((responseStatus() ?? 200) >= 400 || action === "blocked") resolution = "ip-blocked"
        else if (!current || action || hasWallFrame(page)) resolution = "captcha-required"
      }
      if (signal?.aborted) {
        onCaptcha?.([{ kind: wallSolver.type, outcome: "failed" }])
        return result
      }
      result = { challengeType: wallSolver.type, resolution }
      if (resolution === "ok") {
        onCaptcha?.([{ kind: wallSolver.type, outcome: "solved" }])
        return { ...result, captchasSolved: [wallSolver.type] }
      }
    }
    onCaptcha?.([{ kind: wallSolver.type, outcome: "failed" }])
  }
  if (
    !eligible ||
    !external ||
    result.resolution === "ok" ||
    result.resolution === "browser-closed" ||
    (result.resolution === "ip-blocked" &&
      (!managedCloudflare || !result.challengeType.startsWith("cloudflare-") || isCloudflareErrorUrl(page.url()))) ||
    signal?.aborted
  )
    return result
  const solved = await external.solveProfiles(
    page,
    Math.max(0, deadline - Date.now()),
    signal,
    proxy,
    (kind, delivered) => {
      if (!delivered) onCaptcha?.([{ kind, outcome: "failed" }])
    },
  )
  if (signal?.aborted) {
    onCaptcha?.(solved.map((kind) => ({ kind, outcome: "failed" })))
    return result
  }
  // A delayed or unsupported render must not shorten the original local wait.
  if (!solved.length && !(managedCloudflare && result.resolution === "timeout")) return result
  const verified = await routeLocalChallengeWait(
    page,
    await page.content().catch(() => ""),
    responseHeaders(),
    Math.max(0, deadline - Date.now()),
    originalUrl,
    waiters,
    status,
    initialCookies,
    responseHeaders,
  )
  onCaptcha?.(solved.map((kind) => ({ kind, outcome: verified.resolution === "ok" ? "solved" : "failed" })))
  return verified.resolution === "ok" && solved.length ? { ...verified, captchasSolved: solved } : verified
}
