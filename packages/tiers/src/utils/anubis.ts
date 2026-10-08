import { parseHTML } from "linkedom"

// This function also runs inside the browser. Keep its dependencies local so
// polling returns a small DOM summary instead of copying the page HTML.
export function inspectAnubisDocument(root: Document = document): {
  state?: "challenge" | "blocked"
  ready: boolean
  content: boolean
} {
  const attribute = (node: Element, name: string) =>
    Array.from(node.attributes).find((attr) => attr.name.toLowerCase() === name)?.value
  const active = (node: Element) => !node.closest("template,noscript,textarea,style")
  let version = false
  let challenge = false
  let bootstrap = false
  for (const script of root.querySelectorAll("script")) {
    if (!active(script)) continue
    if (/\/\.within\.website\/x\/cmd\/anubis\/static\/js\/main\.mjs(?:[?#]|$)/.test(attribute(script, "src") ?? ""))
      bootstrap = true
    const id = attribute(script, "id")
    if (
      (id !== "anubis_challenge" && id !== "anubis_version") ||
      attribute(script, "type")?.toLowerCase() !== "application/json"
    )
      continue
    try {
      const data = JSON.parse(script.textContent ?? "")
      if (id === "anubis_version") version = typeof data === "string" && data.length > 0
      else challenge = Boolean(data?.rules?.algorithm && data?.challenge?.id && data?.challenge?.randomData)
    } catch {
      // Invalid metadata still counts as a wall when the real bootstrap is present.
    }
  }
  const rejected =
    version &&
    Array.from(root.querySelectorAll("img")).some(
      (image) =>
        active(image) &&
        /\/\.within\.website\/x\/cmd\/anubis\/static\/img\/reject\.webp(?:[?#]|$)/.test(attribute(image, "src") ?? ""),
    )
  const state = rejected ? "blocked" : challenge || (version && bootstrap) ? "challenge" : undefined
  const body = root.body
  return {
    state,
    ready: root.readyState !== "loading",
    content:
      !state &&
      Boolean(body?.innerText?.trim() || body?.querySelector("img,svg,canvas,video,audio,iframe,embed,object")),
  }
}

export function detectAnubisPage(html: string): "challenge" | "blocked" | undefined {
  if (!/anubis_(?:challenge|version)|\/\.within\.website\/x\/cmd\/anubis\//.test(html)) return
  return inspectAnubisDocument(parseHTML(html).document).state
}

export function isAnubisVerificationUrl(url: string): boolean {
  try {
    return /\/\.within\.website\/x\/cmd\/anubis\/api\//.test(new URL(url).pathname)
  } catch {
    return false
  }
}

export function hasAnubisDestinationContent(html: string): boolean {
  const body = html.replace(
    /<head\b[^>]*>[\s\S]*?<\/head\s*>|<!--[\s\S]*?-->|<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  )
  return (
    /<(?:img|svg|canvas|video|audio|iframe|embed|object)\b/i.test(body) ||
    body.replace(/<[^>]*>/g, "").trim().length > 0
  )
}

export function anubisInspectionText(bytes: Uint8Array, preview: string): string {
  if (bytes.length <= 65536) return preview
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return buffer.indexOf("anubis_") >= 0 || buffer.indexOf("/.within.website/x/cmd/anubis/") >= 0
    ? new TextDecoder().decode(bytes)
    : preview
}
