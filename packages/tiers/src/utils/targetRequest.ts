import type { ScrapeRequest } from "@trawl/types"
import { RESERVED_HEADER_NAMES, RequestValidationError } from "./sanitize"

export function prepareTargetRequest(req: ScrapeRequest) {
  let body: string | Buffer<ArrayBuffer> | undefined = req.body
  if (req.bodyEncoding !== undefined) {
    if (!["POST", "PUT", "PATCH", "DELETE", "QUERY"].includes(req.method ?? "GET"))
      throw new RequestValidationError("Binary bodies require a body-capable method", 400)
    if (
      req.method !== "POST" &&
      (req.maxTier !== 1 || req.sessionId || req.cookies?.length || req.skipHttp || req.screenshot)
    )
      throw new RequestValidationError(
        "Non-POST binary bodies require HTTP-only maxTier: 1 without a browser session",
        400,
      )
    if (
      req.bodyEncoding !== "base64" ||
      typeof body !== "string" ||
      body.length > 1398104 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)
    )
      throw new RequestValidationError("bodyEncoding requires a base64 body of at most 1 MiB decoded", 400)
    const bytes = Buffer.from(body, "base64")
    if (bytes.length > 1048576 || bytes.toString("base64") !== body)
      throw new RequestValidationError("Invalid base64 target body", 400)
    body = bytes
  }
  let url = req.url
  let credential: { name: string; value: string } | undefined
  if (req.targetAuth !== undefined) {
    const auth = req.targetAuth
    const invalid = () => {
      throw new RequestValidationError("Invalid target authentication", 400)
    }
    const text = (value: unknown, empty = false): value is string =>
      typeof value === "string" &&
      (empty || value.length > 0) &&
      value.length <= 8192 &&
      ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) invalid()
    if (req.maxTier !== 1 || req.sessionId || req.skipHttp || req.cookies?.length || req.screenshot)
      throw new RequestValidationError(
        "Target authentication requires HTTP-only maxTier: 1 without a browser session or imported cookies",
        400,
      )
    if (auth.type === "basic") {
      if (!text(auth.username, true) || !text(auth.password, true) || auth.username.includes(":")) invalid()
      credential = {
        name: "Authorization",
        value: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`,
      }
    } else if (auth.type === "bearer") {
      if (!text(auth.token) || !/^[A-Za-z0-9\-._~+/]+=*$/.test(auth.token)) invalid()
      credential = { name: "Authorization", value: `Bearer ${auth.token}` }
    } else if (auth.type === "api-key") {
      if (!text(auth.name) || auth.name.length > 256 || !text(auth.value) || !["header", "query"].includes(auth.in))
        invalid()
      if (auth.in === "query") {
        let target: URL
        try {
          target = new URL(url)
        } catch {
          return invalid()
        }
        target.searchParams.set(auth.name, auth.value)
        url = target.href
      } else {
        if (
          !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(auth.name) ||
          (RESERVED_HEADER_NAMES.has(auth.name.toLowerCase()) && auth.name.toLowerCase() !== "authorization")
        )
          invalid()
        credential = { name: auth.name, value: auth.value }
      }
    } else invalid()
  }
  return { url, body, credential }
}
