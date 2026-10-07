import { expect, test } from "bun:test"
import { runSubprocess } from "../src/solvers/subprocess"

test("cancellation terminates the owned subprocess before returning", async () => {
  const start = performance.now()
  const result = runSubprocess([process.execPath, "-e", "setInterval(() => {}, 1000)"], AbortSignal.timeout(50))
  await expect(result).rejects.toThrow()
  expect(performance.now() - start).toBeLessThan(500)
})

test("preserves normal subprocess completion and stderr", async () => {
  expect(await runSubprocess([process.execPath, "-e", "process.stderr.write('fixture');process.exit(7)"])).toEqual({
    exitCode: 7,
    stderr: "fixture",
  })
})
