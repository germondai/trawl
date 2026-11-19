export function parseProcessLog(message: string) {
  const match = /^(?:(\d{4}-\d{2}-\d{2}T\S+)\s+)?level=(error|warn|info|debug)\s+scope=([\w.-]+)\s+([\s\S]*)$/.exec(
    message,
  )
  if (match)
    return {
      at: match[1] && Number.isFinite(Date.parse(match[1])) ? match[1] : "",
      level: match[2]!,
      scope: match[3]!,
      message: match[4]!,
    }
  return { at: "", level: "info", scope: "process", message }
}
