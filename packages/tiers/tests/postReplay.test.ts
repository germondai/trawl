import { expect, test } from "bun:test"
import type { Request, Response } from "patchright"
import { RequestBudget } from "../src/utils/deadline"
import { PostReplay } from "../src/utils/postReplay"

test("one rejection permits only one concurrent POST, and cannot authorize another while it is pending", async () => {
  const budget = new RequestBudget(1000)
  const replay = new PostReplay(budget)
  const first = {} as Request
  try {
    replay.beginAttempt()
    expect(await replay.submit(first)).toBe(true)
    replay.observe({
      request: () => first,
      status: () => 403,
      headers: () => ({ "cf-mitigated": "challenge" }),
    } as unknown as Response)
    expect(await Promise.all([replay.submit({} as Request), replay.submit({} as Request)])).toEqual([true, false])
    expect(await replay.canRetry()).toBe(false)
  } finally {
    budget.dispose()
  }
})
