import type {
  ExtractRequest,
  ExtractResponse,
  InstanceCapabilities,
  ReadResponse,
  ScrapeRequest,
  ScrapeResponse,
  TargetAuth,
  Trawl,
} from "@trawl/client"
import { jsonPreview } from "./json-preview"
import { LocalizedError, t } from "./localization"
import { base64Bytes, multipartBody } from "./request-body"
import { emptyRequestField, type RequestField } from "./request-fields"

export const targetMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "QUERY"] as const
export const workbenchOutputs = [
  { label: "HTML", value: "html" },
  {
    get label() {
      return t("ui.markdown")
    },
    value: "markdown",
  },
  {
    get label() {
      return t("ui.plainText")
    },
    value: "text",
  },
  {
    get label() {
      return t("ui.extractJson")
    },
    value: "extract",
  },
  {
    get label() {
      return t("ui.screenshot")
    },
    value: "screenshot",
  },
  {
    get label() {
      return t("ui.browserDiagnostics")
    },
    value: "inspect",
  },
] as const
export interface WorkbenchDraft {
  url: string
  method: (typeof targetMethods)[number]
  output: (typeof workbenchOutputs)[number]["value"]
  headers: string
  bodyMode: "none" | "json" | "text" | "urlencoded" | "form" | "graphql" | "binary"
  body: string
  binaryName: string
  auth: {
    type: "none" | "basic" | "bearer" | "api-key"
    username: string
    password: string
    token: string
    name: string
    value: string
    in: "header" | "query"
  }
  bodyContentType: string
  graphqlVariables: string
  fields: Record<"params" | "headers" | "body", RequestField[]>
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
    binaryName: "",
    auth: { type: "none", username: "", password: "", token: "", name: "X-API-Key", value: "", in: "header" },
    bodyContentType: "text/plain; charset=utf-8",
    graphqlVariables: "{}",
    fields: { params: [emptyRequestField()], headers: [emptyRequestField()], body: [emptyRequestField()] },
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
export function replacesWorkbenchDraft(current: WorkbenchDraft, next: WorkbenchDraft) {
  const empty = newWorkbenchDraft()
  return JSON.stringify(current) !== JSON.stringify(empty) && JSON.stringify(current) !== JSON.stringify(next)
}
function hasBinaryBody(draft: WorkbenchDraft) {
  return (
    draft.bodyMode === "binary" ||
    (draft.bodyMode === "form" && draft.fields.body.some((row) => row.enabled && row.file))
  )
}
export function httpOnlyWorkbench(draft: WorkbenchDraft) {
  return draft.auth.type !== "none" || (hasBinaryBody(draft) && draft.method !== "POST")
}
export function requireWorkbenchCapabilities(draft: WorkbenchDraft, capabilities?: InstanceCapabilities | null) {
  const binary = hasBinaryBody(draft)
  const auth = draft.auth.type !== "none"
  if (!binary && !auth) return
  if (!capabilities) throw new LocalizedError("ui.connectToARunningInstanceToVerifyBinary")
  if ((binary && !capabilities.requestOptions?.binaryBodies) || (auth && !capabilities.requestOptions?.targetAuth))
    throw new LocalizedError("ui.updateThisTrawlInstanceToUseBinaryFile")
}
export function capturedWorkbenchDraft(input: unknown): WorkbenchDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LocalizedError("ui.invalidCapturedRequest")
  const record = input as Record<string, unknown>
  if (record.version !== 1 || !["scrape", "read", "extract"].includes(String(record.operation)))
    throw new LocalizedError("ui.unsupportedCapturedRequestVersion")
  const request = record.parameters as Record<string, unknown> | undefined
  if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.url !== "string")
    throw new LocalizedError("ui.capturedRequestHasNoTargetUrl")
  const draft = newWorkbenchDraft()
  draft.url = request.url
  draft.method = (request.method ?? "GET") as WorkbenchDraft["method"]
  draft.timeout =
    typeof request.maxTimeout === "number" ? Math.min(180, Math.max(1, Math.ceil(request.maxTimeout / 1000))) : 60
  draft.maxTier = (request.maxTier ?? 4) as WorkbenchDraft["maxTier"]
  draft.sessionId = typeof request.sessionId === "string" ? request.sessionId : ""
  draft.headers = JSON.stringify(request.headers ?? {}, null, 2)
  if (record.source === "proxy" && request.headers && typeof request.headers === "object") {
    const unsupported = Object.keys(request.headers).filter((name) =>
      [
        "authorization",
        "cookie",
        "user-agent",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-forwarded-port",
        "x-real-ip",
        "cf-connecting-ip",
        "cf-ipcountry",
        "cf-ray",
        "cf-worker",
        "cf-cache-status",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "sec-fetch-user",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
      ].includes(name.trim().toLowerCase()),
    )
    if (unsupported.length)
      throw new LocalizedError("ui.theNativeApiCannotReplayTheseProxyHeaders", { p0: unsupported.join(", ") })
  }
  if (request.body !== undefined) {
    draft.bodyMode =
      record.bodyEncoding === "base64" || request.bodyEncoding === "base64"
        ? "binary"
        : typeof request.body === "string"
          ? "text"
          : "json"
    draft.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body, null, 2)
    if (draft.bodyMode === "binary") {
      base64Bytes(draft.body)
      draft.binaryName = t("ui.capturedPayload")
    }
  }
  if (request.targetAuth) {
    const auth = request.targetAuth as TargetAuth
    if (!auth || typeof auth !== "object" || !["basic", "bearer", "api-key"].includes(auth.type))
      throw new LocalizedError("ui.invalidCapturedTargetAuthentication")
    for (const value of Object.values(auth))
      if (typeof value !== "string") throw new LocalizedError("ui.invalidCapturedTargetAuthentication")
    draft.auth = { ...draft.auth, ...auth }
  }
  draft.options = JSON.stringify(
    Object.fromEntries(Object.entries(request).filter(([name]) => advancedKeys.has(name))),
    null,
    2,
  )
  if (record.operation === "read") draft.output = request.format === "text" ? "text" : "markdown"
  if (record.operation === "extract") {
    draft.output = "extract"
    draft.extraction = JSON.stringify(
      Object.fromEntries(
        Object.entries(request).filter(([name]) => ["itemSelector", "fields", "maxItems", "render"].includes(name)),
      ),
      null,
      2,
    )
  }
  workbenchRequest(draft)
  return draft
}

function objectJSON(text: string, labelKey: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new LocalizedError("validation.jsonSyntax", {
      get label() {
        return t(labelKey)
      },
    })
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LocalizedError("validation.jsonObject", {
      get label() {
        return t(labelKey)
      },
    })
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
  "maxCharacters",
])

export function workbenchRequest(draft: WorkbenchDraft): ScrapeRequest & { maxCharacters?: number } {
  if (JSON.stringify(draft).length > 256 * 1024) throw new LocalizedError("ui.draftExceedsThe256KibCharacterLimit")
  let url: URL
  try {
    url = new URL(draft.url.trim())
  } catch {
    throw new LocalizedError("ui.enterACompleteHttpSTargetUrl")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new LocalizedError("ui.useAnHttpSTargetUrlWithoutEmbedded")
  if (!targetMethods.includes(draft.method)) throw new LocalizedError("ui.unsupportedTargetMethod")
  if (!Number.isInteger(draft.timeout) || draft.timeout < 1 || draft.timeout > 180)
    throw new LocalizedError("ui.timeoutMustBeFrom1To180Seconds")
  if (![1, 2, 3, 4].includes(draft.maxTier)) throw new LocalizedError("ui.invalidTierLimit")
  if (draft.sessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(draft.sessionId))
    throw new LocalizedError("ui.invalidSessionId")
  const headers = objectJSON(draft.headers, "ui.headers")
  if (Object.values(headers).some((value) => typeof value !== "string"))
    throw new LocalizedError("ui.headerValuesMustBeStrings")
  if (Object.keys(headers).some((name) => name.toLowerCase() === "authorization"))
    throw new LocalizedError("ui.useTheAuthTabForTargetAuthorization")
  const options = objectJSON(draft.options, "ui.advancedOptions")
  for (const name of Object.keys(options))
    if (!advancedKeys.has(name)) throw new LocalizedError("ui.useTheDedicatedFieldForOrRemoveThis", { p0: name })
  if (
    options.maxCharacters !== undefined &&
    (!["text", "markdown"].includes(draft.output) ||
      !Number.isInteger(options.maxCharacters) ||
      Number(options.maxCharacters) < 1 ||
      Number(options.maxCharacters) > 100000)
  )
    throw new LocalizedError("validation.maxCharacters")
  let body: string | object | undefined
  let bodyEncoding: "base64" | undefined
  if (draft.bodyMode === "json") {
    try {
      body = JSON.parse(draft.body) as unknown as object
    } catch {
      throw new LocalizedError("ui.bodyMustBeValidJson")
    }
    if (!body || typeof body !== "object") throw new LocalizedError("ui.jsonBodyMustBeAnObjectOrArray")
  } else if (draft.bodyMode === "graphql") {
    body = { query: draft.body, variables: objectJSON(draft.graphqlVariables, "ui.graphqlVariables") }
  } else if (draft.bodyMode === "form") {
    const multipart = multipartBody(draft.body, draft.fields.body)
    body = multipart.body
    bodyEncoding = multipart.bodyEncoding
    for (const key of Object.keys(headers)) if (key.toLowerCase() === "content-type") delete headers[key]
    headers["Content-Type"] = multipart.contentType
  } else if (draft.bodyMode === "binary") {
    if (!draft.binaryName) throw new LocalizedError("ui.chooseABinaryBodyFile")
    base64Bytes(draft.body)
    body = draft.body
    bodyEncoding = "base64"
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type"))
      headers["Content-Type"] = "application/octet-stream"
  } else if (draft.bodyMode === "urlencoded" || draft.bodyMode === "text") {
    body =
      draft.bodyMode === "urlencoded"
        ? new URLSearchParams(draft.body.split("\n").filter(Boolean).join("&")).toString()
        : draft.body
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type"))
      headers["Content-Type"] =
        draft.bodyMode === "urlencoded" ? "application/x-www-form-urlencoded" : draft.bodyContentType
  }
  if ((draft.method === "GET" || draft.method === "HEAD") && body !== undefined)
    throw new LocalizedError("ui.chooseABodyCapableTargetMethodBeforeSending")
  if ((draft.output === "screenshot" || draft.output === "inspect") && draft.maxTier === 1)
    throw new LocalizedError("ui.screenshotAndBrowserDiagnosticsRequireABrowserCapable")
  let targetAuth: TargetAuth | undefined
  if (
    httpOnlyWorkbench(draft) &&
    (draft.sessionId ||
      options.cookies ||
      options.skipHttp ||
      options.screenshot ||
      draft.output === "screenshot" ||
      draft.output === "inspect")
  )
    throw new LocalizedError("ui.targetAuthAndNonPostBinaryBodiesUse")
  if (draft.auth.type !== "none") {
    if (draft.auth.type === "basic")
      targetAuth = { type: "basic", username: draft.auth.username, password: draft.auth.password }
    if (draft.auth.type === "bearer") targetAuth = { type: "bearer", token: draft.auth.token }
    if (draft.auth.type === "api-key")
      targetAuth = { type: "api-key", name: draft.auth.name, value: draft.auth.value, in: draft.auth.in }
  }
  return {
    ...options,
    url: url.href,
    method: draft.method,
    headers: headers as Record<string, string>,
    body,
    ...(bodyEncoding ? { bodyEncoding } : {}),
    ...(targetAuth ? { targetAuth } : {}),
    maxTimeout: draft.timeout * 1000,
    maxTier: httpOnlyWorkbench(draft) ? 1 : draft.maxTier,
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
      const extraction = objectJSON(draft.extraction, "ui.extractionOptions")
      if (Object.keys(extraction).some((name) => !["itemSelector", "fields", "maxItems", "render"].includes(name)))
        throw new LocalizedError("ui.unsupportedExtractionOption")
      const fields = extraction.fields
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length)
        throw new LocalizedError("ui.extractionNeedsAtLeastOneField")
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
