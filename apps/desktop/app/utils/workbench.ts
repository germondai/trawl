import type { ExtractRequest, ExtractResponse, ReadResponse, ScrapeRequest, ScrapeResponse, Trawl } from "@trawl/client"
import { jsonPreview } from "./json-preview"

export const targetMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "QUERY"] as const
export const workbenchOutputs = [
  { label: "HTML", value: "html" },
  { label: "Markdown", value: "markdown" },
  { label: "Plain text", value: "text" },
  { label: "Extract JSON", value: "extract" },
  { label: "Screenshot", value: "screenshot" },
  { label: "Browser diagnostics", value: "inspect" },
] as const
export interface WorkbenchDraft {
  url: string
  method: (typeof targetMethods)[number]
  output: (typeof workbenchOutputs)[number]["value"]
  headers: string
  bodyMode: "none" | "json" | "text"
  body: string
  timeout: number
  maxTier: 1 | 2 | 3 | 4
  sessionId: string
  options: string
  extraction: string
}
export type WorkbenchResult = ScrapeResponse | ReadResponse | ExtractResponse
export function newWorkbenchDraft(): WorkbenchDraft {
  return {
    url: "",
    method: "GET",
    output: "html",
    headers: "{}",
    bodyMode: "none",
    body: "",
    timeout: 60,
    maxTier: 4,
    sessionId: "",
    options: "{}",
    extraction: JSON.stringify(
      {
        itemSelector: "a",
        fields: { text: { selector: ":scope" }, url: { selector: ":scope", attribute: "href" } },
        maxItems: 100,
      },
      null,
      2,
    ),
  }
}

function objectJSON(text: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
  return value as Record<string, unknown>
}

const advancedKeys = new Set([
  "detectWaf",
  "skipHttp",
  "solveEmbeddedCaptchas",
  "cookies",
  "proxy",
  "httpReplay",
  "screenshot",
  "screenshotFullPage",
  "screenshotWaitForSelector",
  "screenshotSelector",
  "contentWaitForSelector",
  "consoleLogs",
  "networkLogs",
  "redirectChain",
  "captureResponses",
  "settleTimeout",
  "waitForSelector",
  "blockedEvidence",
  "mhtml",
  "ignoreCertificateErrors",
  "followMetaRefresh",
  "allowShortContent",
  "favicons",
])

export function workbenchRequest(draft: WorkbenchDraft): ScrapeRequest {
  if (JSON.stringify(draft).length > 256 * 1024) throw new Error("Draft exceeds the 256 KiB character limit")
  let url: URL
  try {
    url = new URL(draft.url.trim())
  } catch {
    throw new Error("Enter a complete HTTP(S) target URL")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use an HTTP(S) target URL without embedded credentials")
  if (!targetMethods.includes(draft.method)) throw new Error("Unsupported target method")
  if (!Number.isInteger(draft.timeout) || draft.timeout < 1 || draft.timeout > 180)
    throw new Error("Timeout must be from 1 to 180 seconds")
  if (![1, 2, 3, 4].includes(draft.maxTier)) throw new Error("Invalid tier limit")
  if (draft.sessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(draft.sessionId)) throw new Error("Invalid session ID")
  const headers = objectJSON(draft.headers, "Headers")
  if (Object.values(headers).some((value) => typeof value !== "string"))
    throw new Error("Header values must be strings")
  const options = objectJSON(draft.options, "Advanced options")
  for (const name of Object.keys(options))
    if (!advancedKeys.has(name))
      throw new Error(`Use the dedicated field for ${name}, or remove this unsupported option`)
  let body: string | object | undefined
  if (draft.bodyMode === "json") {
    try {
      body = JSON.parse(draft.body) as unknown as object
    } catch {
      throw new Error("Body must be valid JSON")
    }
    if (!body || typeof body !== "object") throw new Error("JSON body must be an object or array")
  } else if (draft.bodyMode === "text") {
    body = draft.body
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type"))
      headers["Content-Type"] = "text/plain; charset=utf-8"
  }
  if ((draft.method === "GET" || draft.method === "HEAD") && body !== undefined)
    throw new Error("Choose a body-capable target method before sending a body")
  if ((draft.output === "screenshot" || draft.output === "inspect") && draft.maxTier === 1)
    throw new Error("Screenshot and browser diagnostics require a browser-capable tier limit")
  return {
    ...options,
    url: url.href,
    method: draft.method,
    headers: headers as Record<string, string>,
    body,
    maxTimeout: draft.timeout * 1000,
    maxTier: draft.maxTier,
    ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
  }
}

export async function sendWorkbench(
  api: Pick<Trawl, "scrape" | "read" | "extract" | "screenshot" | "inspect">,
  draft: WorkbenchDraft,
  signal: AbortSignal,
): Promise<WorkbenchResult> {
  const request = workbenchRequest(draft)
  const wait = { signal, timeoutMs: draft.timeout * 1000 + 10_000 }
  switch (draft.output) {
    case "markdown":
    case "text":
      return api.read({ ...request, format: draft.output }, wait)
    case "extract": {
      const extraction = objectJSON(draft.extraction, "Extraction options")
      if (Object.keys(extraction).some((name) => !["itemSelector", "fields", "maxItems", "render"].includes(name)))
        throw new Error("Unsupported extraction option")
      const fields = extraction.fields
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length)
        throw new Error("Extraction needs at least one field")
      return api.extract({ ...request, ...extraction } as ExtractRequest, wait)
    }
    case "screenshot":
      return api.screenshot({ ...request, maxTier: draft.maxTier as 2 | 3 | 4 }, wait)
    case "inspect":
      return api.inspect({ ...request, maxTier: draft.maxTier as 2 | 3 | 4 }, wait)
    default:
      return api.scrape(request, wait)
  }
}

export function workbenchText(result: WorkbenchResult): string {
  if ("text" in result) return result.text
  if ("html" in result) return result.html
  return jsonPreview(result.items)
}
