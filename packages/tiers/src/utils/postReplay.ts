import type { Page, Request, Response, Route } from "patchright"
import type { RequestBudget } from "./deadline"
import { isExplicitChallengeRejection } from "./detect"
import { decodeTextBody, isHtmlContentType } from "./response"
import { routeContinueOverrides } from "./sanitize"

export class PostReplay {
  private submission?: { request: Request; rejection?: Promise<boolean> }
  private initial = false

  constructor(private readonly budget: RequestBudget) {}

  beginAttempt(): void {
    this.submission = undefined
    this.initial = true
  }

  observe = (response: Response): void => {
    const submission = this.submission
    // Snapshot rejection evidence while the page is still open.
    if (submission?.request === response.request()) submission.rejection = this.rejected(response)
  }

  async submit(request: Request): Promise<boolean> {
    const previous = this.submission
    if ((!this.initial && !(await this.canRetry())) || this.submission !== previous) return false
    // Revoke the previous rejection before dispatching another POST.
    this.initial = false
    this.submission = { request }
    return true
  }

  async canRetry(): Promise<boolean> {
    const submission = this.submission
    if (!submission?.rejection) return false
    return (await submission.rejection) && this.submission === submission
  }

  private async rejected(response: Response): Promise<boolean> {
    try {
      const headers = response.headers()
      if (isExplicitChallengeRejection(response.status(), "", headers)) return true
      if (!isHtmlContentType(headers["content-type"])) return false
      const body = await this.budget.run(() => response.body())
      return (
        body.length <= 262_144 &&
        isExplicitChallengeRejection(response.status(), decodeTextBody(body, headers["content-type"] ?? ""), headers)
      )
    } catch {
      return false
    }
  }
}

export async function installPostReplayRoute(
  page: Page,
  url: string,
  headers: Record<string, string> | undefined,
  body: string | undefined,
  replay: PostReplay,
): Promise<() => Promise<void>> {
  page.on("response", replay.observe)
  const override = async (route: Route) => {
    const options = routeContinueOverrides(route, headers, "POST", body)
    if ((options.method === "POST" || route.request().method() === "POST") && !(await replay.submit(route.request()))) {
      await route.abort("aborted")
      return
    }
    await route.continue(options)
  }
  await page.route(url, override)
  return async () => {
    page.off("response", replay.observe)
    await page.unroute(url, override)
  }
}
