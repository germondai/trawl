import type { Page } from "patchright"
import { solveAwsWaf } from "../solvers/awsWaf"
import type { ExternalCaptchaSession } from "../solvers/externalCaptcha"
import { waitForAkamaiResolution } from "./akamaiWait"
import { type AnubisResolution, waitForAnubisResolution } from "./anubisWait"
import { type AwsWafResolution, waitForAwsWafResolution } from "./awsWafWait"
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
  ) => Promise<Resolution>
  dataDome: (
    page: Page,
    timeoutMs: number,
    originalUrl?: string,
    initialCookies?: ReadonlySet<string>,
  ) => Promise<Resolution>
  // Optional so callers and tests that build their own waiter set never reach a real page.
  awsWafCaptcha?: (page: Page, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>
}

const defaultWaiters: ChallengeWaiters = {
  awsWafCaptcha: solveAwsWaf,
  cloudflare: waitForChallengeResolution,
  imperva: waitForImpervaResolution,
  akamai: waitForAkamaiResolution,
  ddosGuard: waitForDdosGuardResolution,
  awsWaf: (page, timeoutMs, originalUrl, initialTokens) =>
    waitForAwsWafResolution(page, timeoutMs, originalUrl, { initialTokens }),
  dataDome: (page, timeoutMs, originalUrl, initialCookies) =>
    waitForDataDomeResolution(page, timeoutMs, originalUrl, { initialCookies }),
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
  // The AWS WAF CAPTCHA wall is solved through its audio puzzle. A solved wall reloads the
  // page itself, so wait for it to leave the wall before asking the waiter to confirm the
  // new token; otherwise the waiter would still see the CAPTCHA markup and report it.
  if (
    result.challengeType === "aws-waf" &&
    result.resolution === "captcha-required" &&
    waiters.awsWafCaptcha &&
    !signal?.aborted
  ) {
    // With an external solver configured the local attempt gets only its share, like every
    // other local solver, so the fallback is not left without time.
    const available = Math.max(0, deadline - Date.now())
    const localTimeout = eligible && external ? external.localBudget(available) : available
    const localDeadline = Math.min(deadline, Date.now() + localTimeout)
    const solvedWall = await waiters.awsWafCaptcha(page, localTimeout, signal).catch(() => false)
    if (solvedWall && !signal?.aborted) {
      const clearUntil = Math.min(localDeadline, Date.now() + 8_000)
      while (Date.now() < clearUntil && !signal?.aborted) {
        const current = await page.content().catch(() => "")
        if (current && !hasAwsWafCaptcha(current)) break
        await sleep(Math.min(250, Math.max(0, clearUntil - Date.now())), signal).catch(() => {})
      }
      if (signal?.aborted) return result
      const resolution = await waiters.awsWaf(
        page,
        Math.max(0, localDeadline - Date.now()),
        originalUrl,
        initialCookies?.awsWaf,
      )
      result = { challengeType: "aws-waf", resolution }
      if (resolution === "ok") return { ...result, captchasSolved: ["aws-waf"] }
    }
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
  const solved = await external.solveProfiles(page, Math.max(0, deadline - Date.now()), signal, proxy)
  if (signal?.aborted) return result
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
  return verified.resolution === "ok" && solved.length ? { ...verified, captchasSolved: solved } : verified
}
