const allowed = new Set(
  "a abbr address article aside b blockquote br caption cite code col colgroup dd details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i kbd li main mark nav ol p pre q s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var".split(
    " ",
  ),
)
const dropped = new Set(
  "script style link meta base title head iframe frame frameset object embed svg math template noscript canvas audio video source track".split(
    " ",
  ),
)
const voids = new Set(["br", "hr", "col"])
const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => entities[char] ?? char)
const prefix = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><title>Saved response</title><style>
html{color-scheme:dark}body{margin:24px;background:#171719;color:#e9e9ec;font:15px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}*{box-sizing:border-box;max-width:100%}h1,h2,h3,h4{line-height:1.3}a{color:#48ce8a}pre,code,kbd,samp{font-family:ui-monospace,monospace}pre{white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #444;padding:8px}blockquote{border-left:2px solid #666;margin-left:0;padding-left:16px}img{display:none}
</style></head><body>`

/** Readable offline HTML, rather than replaying an untrusted page in the application WebView. */
export function capturedDocument(source: string): { html: string; limited: boolean } {
  if (source.length > 512 * 1024)
    return {
      html: `${prefix}<p>This document exceeds the readable preview limit. Use the source preview or saved screenshot.</p></body></html>`,
      limited: true,
    }
  // Template content is inert: no active document, resource loading or custom-element upgrades.
  const template = document.createElement("template")
  template.innerHTML = source
  const chunks: string[] = []
  let remaining = 1024 * 1024
  let count = 0
  let limited = false
  const append = (value: string) => {
    if (value.length > remaining) {
      limited = true
      return false
    }
    remaining -= value.length
    chunks.push(value)
    return true
  }
  function walk(node: Node, depth: number) {
    if (++count > 5000 || depth > 64 || remaining <= 0) {
      limited = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ""
      const take = Math.max(0, Math.min(text.length, 65536, Math.floor(remaining / 6)))
      append(escapeHtml(text.slice(0, take)))
      if (take < text.length) limited = true
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.localName
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || dropped.has(tag)) return
    if (tag === "img") {
      append(`<span role="img">[${escapeHtml((element.getAttribute("alt") || "Image").slice(0, 256))}]</span>`)
      return
    }
    const keep = allowed.has(tag)
    let closing = ""
    if (keep) {
      const attributes: string[] = []
      for (const name of ["title", "lang", "dir", "colspan", "rowspan", "scope"]) {
        const value = element.getAttribute(name)
        if (!value || value.length > 256) continue
        if (
          (name === "colspan" || name === "rowspan") &&
          (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 20)
        )
          continue
        if (name === "dir" && !["ltr", "rtl", "auto"].includes(value)) continue
        attributes.push(` ${name}="${escapeHtml(value)}"`)
      }
      if (tag === "details" && element.hasAttribute("open")) attributes.push(" open")
      closing = voids.has(tag) ? "" : `</${tag}>`
      const opening = `<${tag}${attributes.join("")}>`
      if (opening.length + closing.length > remaining) {
        limited = true
        return
      }
      remaining -= closing.length
      append(opening)
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (count >= 5000 || remaining <= 0) {
        limited = true
        break
      }
      walk(child, depth + 1)
    }
    if (closing) chunks.push(closing)
  }
  for (let node = template.content.firstChild; node; node = node.nextSibling) {
    if (count >= 5000 || remaining <= 0) {
      limited = true
      break
    }
    walk(node, 0)
  }
  return { html: `${prefix}${chunks.join("")}</body></html>`, limited }
}
