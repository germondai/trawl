import { expect, test } from "bun:test"
import type { ExecutionStage } from "@trawl/types"
import { traceStage } from "./trace"

test("execution spans measure each operation without changing outcomes", async () => {
  const spans: ExecutionStage[] = []
  const result = { status: "blocked", reason: "cloudflare-challenge" }
  expect(
    await traceStage(
      "tier",
      async () => result,
      (span) => spans.push(span),
      1,
    ),
  ).toBe(result)
  const first = spans[0]
  if (!first) throw Error("Span was not recorded")
  expect(first).toMatchObject({ kind: "tier", tier: 1, status: "blocked", reason: "cloudflare-challenge" })
  expect(Number.isFinite(Date.parse(first.startedAt))).toBe(true)
  expect(first.durationMs).toBeGreaterThanOrEqual(0)
  expect(
    await traceStage(
      "tier",
      async () => result,
      () => {
        throw Error("observer failure")
      },
    ),
  ).toBe(result)
  const failure = new Error("original error")
  await expect(
    traceStage(
      "tier",
      async () => {
        throw failure
      },
      (span) => spans.push(span),
    ),
  ).rejects.toBe(failure)
  expect(spans[1]?.status).toBe("error")
})
