import { expect, test } from "bun:test"
import { parseProcessLog } from "../app/utils/process-logs"

test("process logs share event columns without inventing timestamps or dropping messages", () => {
  expect(parseProcessLog("level=warn scope=api event=server.stopping reason=owned")).toEqual({
    at: "",
    level: "warn",
    scope: "api",
    message: "event=server.stopping reason=owned",
  })
  expect(parseProcessLog("[pool] browser 1/1 ready")).toEqual({
    at: "",
    level: "info",
    scope: "process",
    message: "[pool] browser 1/1 ready",
  })
  expect(parseProcessLog("2026-11-18T12:00:00Z level=error scope=scrape event=request.failed").at).toBe(
    "2026-11-18T12:00:00Z",
  )
})
