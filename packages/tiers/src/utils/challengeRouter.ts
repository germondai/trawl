import type { Page } from "patchright"
import { waitForAkamaiResolution } from "./akamaiWait"
import { type AwsWafResolution, waitForAwsWafResolution } from "./awsWafWait"
import { waitForChallengeResolution } from "./challengeWait"
import type { ChallengeCookieSnapshot } from "./cookies"
import { type DataDomeResolution, waitForDataDomeResolution } from "./datadomeWait"
import { waitForDdosGuardResolution } from "./ddosGuardWait"
import { type ChallengeType, detectChallengeType, getAwsWafAction, getDataDomeAction, hasAwsWafCaptcha } from "./detect"
import { waitForImpervaResolution } from "./impervaWait"

type Resolution = AwsWafResolution | DataDomeResolution
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
}

const defaultWaiters: ChallengeWaiters = {
  cloudflare: waitForChallengeResolution,
  imperva: waitForImpervaResolution,
  akamai: waitForAkamaiResolution,
  ddosGuard: waitForDdosGuardResolution,
  awsWaf: (page, timeoutMs, originalUrl, initialTokens) =>
    waitForAwsWafResolution(page, timeoutMs, originalUrl, { initialTokens }),
  dataDome: (page, timeoutMs, originalUrl, initialCookies) =>
    waitForDataDomeResolution(page, timeoutMs, originalUrl, { initialCookies }),
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
): Promise<{ challengeType: ChallengeType; resolution: Resolution }> {
  const challengeType = detectChallengeType(html, headers, status)
  if (getAwsWafAction(status, headers) === "captcha" || hasAwsWafCaptcha(html)) {
    return { challengeType: "aws-waf", resolution: "captcha-required" }
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
              : await waiters.cloudflare(page, timeoutMs, originalUrl, () => headers)
  return { challengeType, resolution }
}
