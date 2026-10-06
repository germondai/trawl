import { parseHTML } from "linkedom"

export type AnubisPageState = "challenge" | "blocked"

const attribute = (element: Element, name: string): string | undefined =>
  Array.from(element.attributes).find((attr) => attr.name.toLowerCase() === name)?.value

// Case-sensitive ID values, case-insensitive HTML attribute names. Ignore examples
// in raw-text elements and inert containers, including uppercase attribute names.
const active = (element: Element): boolean => !element.closest("template,noscript,textarea,style")

export interface AnubisPage {
  state: AnubisPageState
  challengeId?: string
}

export function inspectAnubisPage(html: string): AnubisPage | undefined {
  if (!/anubis_(?:challenge|version)|\/\.within\.website\/x\/cmd\/anubis\//.test(html)) return
  const { document } = parseHTML(html)
  let version = false
  let envelope: Omit<AnubisPage, "state"> | undefined
  let bootstrap = false
  let rejected = false
  for (const script of document.querySelectorAll("script")) {
    if (!active(script)) continue
    const src = attribute(script, "src") ?? ""
    if (/\/\.within\.website\/x\/cmd\/anubis\/static\/js\/main\.mjs(?:[?#]|$)/.test(src)) bootstrap = true
    if (attribute(script, "type")?.trim().toLowerCase() !== "application/json") continue
    const id = attribute(script, "id")
    if (id !== "anubis_version" && id !== "anubis_challenge") continue
    try {
      const payload = JSON.parse(script.textContent ?? "")
      if (id === "anubis_version") {
        version = typeof payload === "string" && payload.length > 0
      } else if (
        typeof payload?.rules?.algorithm === "string" &&
        payload.rules.algorithm.length > 0 &&
        typeof payload?.challenge?.id === "string" &&
        payload.challenge.id.length > 0 &&
        typeof payload?.challenge?.randomData === "string" &&
        payload.challenge.randomData.length > 0
      )
        envelope = {
          challengeId: payload.challenge.id,
        }
    } catch {
      // A broken envelope is still a wall when the site's real bootstrap is present.
    }
  }
  if (version) {
    for (const image of document.querySelectorAll("img")) {
      if (
        active(image) &&
        /\/\.within\.website\/x\/cmd\/anubis\/static\/img\/reject\.webp(?:[?#]|$)/.test(attribute(image, "src") ?? "")
      ) {
        rejected = true
        break
      }
    }
  }
  if (rejected) return { state: "blocked", ...envelope }
  if (envelope || (version && bootstrap)) return { state: "challenge", ...envelope }
}

// Most responses never enter the HTML parser. Inspect beyond the normal preview
// only when the already-buffered representation contains Anubis's private markers.
export function anubisInspectionText(bytes: Uint8Array, preview: string): string {
  if (bytes.length <= 65536) return preview
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.indexOf("anubis_") < 0 && buffer.indexOf("/.within.website/x/cmd/anubis/") < 0) return preview
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

export function detectAnubisPage(html: string): AnubisPageState | undefined {
  return inspectAnubisPage(html)?.state
}

export function isAnubisVerificationUrl(url: string): boolean {
  try {
    return /\/\.within\.website\/x\/cmd\/anubis\/api\//.test(new URL(url).pathname)
  } catch {
    return false
  }
}

export function hasAnubisDestinationContent(html: string): boolean {
  html = html.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, "")
  html = html.replace(/<!--[\s\S]*?-->|<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  if (/<(?:img|svg|canvas|video|audio|iframe|embed|object)\b/i.test(html)) return true
  return html.replace(/<[^>]*>/g, "").trim().length > 0
}
