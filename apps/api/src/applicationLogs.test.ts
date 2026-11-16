import { expect, test } from "bun:test"

test("the remote application-log journal contains bounded metadata without private diagnostic text", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "-e",
      `
      const { log } = await import("./logger.ts")
      const { applicationLogs } = await import("./applicationLogs.ts")
      console.log = () => {}
      log("info", "scrape", { event:"request.start",request:"test-id",method:"POST",password:"private-key",target:"https://private-key@example.test",reason:"private-key",body:"private-key" })
      process.stdout.write(JSON.stringify(applicationLogs.snapshot()))
    `,
    ],
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH,
      OBSERVABILITY_ENABLED: "true",
      METRICS_DASHBOARD_TOKEN: "private-test-token-abcdefghijklmnopqrstuvwxyz",
    },
    timeout: 10_000,
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const data = result.stdout.toString()
  expect(data).not.toContain("private-key")
  expect(data).not.toContain("private-test-token")
  expect(JSON.parse(data).entries[0].data.message).toBe("event=request.start request=test-id method=POST")
})
