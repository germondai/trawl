import { readText } from "@trawl/runtime"
import { runCli } from "./cli"

const controller = new AbortController()
const cancel = () => {
  controller.abort()
  process.stdin.destroy()
}
process.once("SIGINT", cancel)
const code = await runCli(process.argv.slice(2), {
  out: (value) => process.stdout.write(value),
  err: (value) => process.stderr.write(value),
  input: () => readText(process.stdin),
  signal: controller.signal,
})
process.removeListener("SIGINT", cancel)
process.exitCode = code
