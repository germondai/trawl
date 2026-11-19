import type { RequestHistoryQuery } from "@trawl/types"

export function parseHistoryQuery(params: URLSearchParams): RequestHistoryQuery {
  const value: RequestHistoryQuery = {}
  const allowed = new Set(["limit", "before", "page", "search", "source", "result", "tier", "sort"])
  if ([...params.keys()].some((key) => !allowed.has(key) || params.getAll(key).length !== 1))
    throw new Error("Invalid history query")
  const page = params.get("page")
  if (page !== null) {
    if (!/^[1-9]\d{0,4}$/.test(page) || Number(page) > 50000) throw new Error("Invalid history page")
    value.page = Number(page)
  }
  const search = params.get("search")
  if (search !== null) {
    if (search.length > 200 || /\p{Cc}/u.test(search)) throw new Error("Invalid history search")
    value.search = search.trim()
  }
  const choices = {
    source: ["native", "flaresolverr", "mcp", "proxy"],
    result: ["success", "failed"],
    sort: ["newest", "oldest", "slowest", "fastest"],
  }
  for (const name of ["source", "result", "sort"] as const) {
    const choice = params.get(name)
    if (choice !== null) {
      if (!choices[name].includes(choice)) throw new Error(`Invalid history ${name}`)
      Object.assign(value, { [name]: choice })
    }
  }
  const tier = params.get("tier")
  if (tier !== null) {
    if (!/^[0-4]$/.test(tier)) throw new Error("Invalid history tier")
    value.tier = Number(tier)
  }
  if (params.has("before") && Object.keys(value).length) throw new Error("Use either a history cursor or a page query")
  return value
}
