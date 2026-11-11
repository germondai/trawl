import { type AltchaChallenge, solveAltcha } from "../solvers/altchaPow"
import { fetchAndSolveFriendlyCaptcha, solveFriendlyCaptchaV1 } from "../solvers/friendlyCaptchaPow"

export interface PowCaptchaPlan {
  kind: "friendly-captcha-v1" | "altcha"
  submit: (
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<
    | {
        fieldName: string
        fieldValue: string
        formAction?: string
        formMethod?: string
      }
    | undefined
  >
}

export function planFriendlyCaptcha(html: string, pageUrl: string): PowCaptchaPlan | undefined {
  const sitekeyMatch = html.match(
    /<[^>]+\bclass\s*=\s*["'][^"']*\bfrc-captcha\b[^"']*["'][^>]*\bdata-sitekey\s*=\s*["']([^"']+)["']/i,
  )
  const puzzleMatch = html.match(
    /<[^>]+\bclass\s*=\s*["'][^"']*\bfrc-captcha\b[^"']*["'][^>]*\bdata-puzzle\s*=\s*["']([^"']+)["']/i,
  )
  const formMatch = html.match(/<form[^>]*\baction\s*=\s*["']([^"']+)["'][^>]*>/i)
  const methodMatch = html.match(/<form[^>]*\bmethod\s*=\s*["']([^"']+)["'][^>]*>/i)

  const hasCallback = /<[^>]+\bclass\s*=\s*["'][^"']*\bfrc-captcha\b[^"']*["'][^>]*\bdata-callback\s*=/i.test(html)
  if (hasCallback) return undefined

  const hasFrcInput =
    /<input\b[^>]*\bname\s*=\s*["']frc-captcha-solution["']/i.test(html) ||
    /<input\b[^>]*\bname\s*=\s*["']frc-captcha-response["']/i.test(html)
  if (!hasFrcInput) return undefined

  const fieldNameMatch = html.match(/<input\b[^>]*\bname\s*=\s*["'](frc-captcha-(?:solution|response))["']/i)
  const fieldName = fieldNameMatch?.[1] ?? "frc-captcha-solution"

  if (!sitekeyMatch?.[1] && !puzzleMatch?.[1]) return undefined

  const sitekey = sitekeyMatch?.[1]
  const embeddedPuzzle = puzzleMatch?.[1]
  const formAction = formMatch?.[1] ? new URL(formMatch[1], pageUrl).href : undefined
  const formMethod = methodMatch?.[1]?.toUpperCase()

  return {
    kind: "friendly-captcha-v1",
    submit: async (_timeoutMs, signal) => {
      let solution: { response: string } | undefined

      if (embeddedPuzzle) {
        solution = solveFriendlyCaptchaV1(embeddedPuzzle)
      } else if (sitekey) {
        solution = await fetchAndSolveFriendlyCaptcha(sitekey, signal)
      }

      if (!solution || signal?.aborted) return undefined

      return {
        fieldName,
        fieldValue: solution.response,
        formAction,
        formMethod,
      }
    },
  }
}

export function planAltcha(html: string, _pageUrl: string): PowCaptchaPlan | undefined {
  const challengeMatchDouble = html.match(/<altcha-widget\b[^>]*\bchallengejson\s*=\s*"([^"]+)"/i)
  const challengeMatchSingle = html.match(/<altcha-widget\b[^>]*\bchallengejson\s*=\s*'([^']+)'/i)
  const challengeMatch = challengeMatchDouble || challengeMatchSingle
  const challengeUrlMatch = html.match(/<altcha-widget\b[^>]*\bchallengeurl\s*=\s*["']([^"']+)["']/i)

  const hasCallback = /<altcha-widget\b[^>]*\bonverified\s*=/i.test(html)
  if (hasCallback) return undefined

  const hasAltchaInput = /<input\b[^>]*\bname\s*=\s*["']altcha["']/i.test(html)
  if (!hasAltchaInput && !challengeMatch && !challengeUrlMatch) return undefined

  const formMatch = html.match(/<form[^>]*\baction\s*=\s*["']([^"']+)["'][^>]*>/i)
  const methodMatch = html.match(/<form[^>]*\bmethod\s*=\s*["']([^"']+)["'][^>]*>/i)

  if (!challengeMatch?.[1]) return undefined

  let challengeJson: AltchaChallenge | undefined
  try {
    const decoded = challengeMatch[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    challengeJson = JSON.parse(decoded) as AltchaChallenge
  } catch {
    return undefined
  }

  if (!challengeJson.algorithm || !challengeJson.salt) return undefined

  return {
    kind: "altcha",
    submit: async (_timeoutMs, signal) => {
      if (signal?.aborted || !challengeJson) return undefined

      const solution = await solveAltcha(challengeJson)
      if (!solution) return undefined

      const payload = btoa(
        JSON.stringify({
          algorithm: challengeJson.algorithm,
          challenge: challengeJson.challenge || `${challengeJson.salt}:${challengeJson.keyPrefix}`,
          number: solution.solution.counter,
          salt: challengeJson.salt,
          signature: "",
          took: solution.solution.time,
        }),
      )

      return {
        fieldName: "altcha",
        fieldValue: payload,
        formAction: formMatch?.[1],
        formMethod: methodMatch?.[1]?.toUpperCase(),
      }
    },
  }
}

export function planPowCaptcha(html: string, pageUrl: string): PowCaptchaPlan | undefined {
  if (html.length > 262_144) return undefined

  const fcPlan = planFriendlyCaptcha(html, pageUrl)
  if (fcPlan) return fcPlan

  const altchaPlan = planAltcha(html, pageUrl)
  if (altchaPlan) return altchaPlan

  return undefined
}
