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
const styleProperties = new Set(
  `display position top right bottom left inset width height min-width max-width min-height max-height box-sizing margin margin-top margin-right margin-bottom margin-left margin-inline margin-block padding padding-top padding-right padding-bottom padding-left padding-inline padding-block border border-width border-style border-color border-top border-right border-bottom border-left border-radius border-collapse border-spacing color background background-color font font-family font-size font-style font-weight line-height letter-spacing text-align text-decoration text-transform text-indent text-overflow vertical-align white-space word-break overflow-wrap overflow overflow-x overflow-y opacity box-shadow outline outline-color outline-style outline-width list-style-type list-style-position flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-self align-content justify-content justify-items justify-self gap row-gap column-gap grid-template-columns grid-template-rows grid-auto-flow grid-auto-columns grid-auto-rows grid-column grid-row order color-scheme visibility`.split(
    " ",
  ),
)
const styleFunctions = new Set(
  "calc min max clamp rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix light-dark linear-gradient radial-gradient repeating-linear-gradient repeating-radial-gradient repeat minmax fit-content".split(
    " ",
  ),
)
function safeStyle(style: CSSStyleDeclaration, root?: "visible" | "hidden"): string {
  const values: string[] = []
  for (let index = 0; index < style.length; index++) {
    const name = style[index]!
    const value = style.getPropertyValue(name)
    if (!styleProperties.has(name) || value.length > 1024 || /[\\<>@{}]/.test(value)) continue
    // Some pages hide their root until a script runs; scripts never run in this preview.
    const hidesRoot =
      (name === "display" && value === "none") ||
      (name === "visibility" && ["hidden", "collapse"].includes(value)) ||
      (name === "opacity" && Number(value) === 0)
    if ((root === "visible" && hidesRoot) || (root === "hidden" && !hidesRoot)) continue
    if ([...value.matchAll(/([a-z-]+)\s*\(/gi)].some((match) => !styleFunctions.has(match[1]!.toLowerCase()))) continue
    values.push(
      `${name}:${value}${typeof style.getPropertyPriority === "function" && style.getPropertyPriority(name) ? " !important" : ""}`,
    )
  }
  return values.join(";")
}
function splitSelectors(source: string): string[] {
  const selectors: string[] = []
  let start = 0,
    depth = 0,
    quote = ""
  // CSSOM has parsed the selectors; escaped selectors are rejected before this split.
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (quote) {
      if (char === quote) quote = ""
    } else if (char === '"' || char === "'") quote = char
    else if (char === "(" || char === "[") depth++
    else if (char === ")" || char === "]") depth--
    else if (char === "," && depth === 0) {
      selectors.push(source.slice(start, i).trim())
      start = i + 1
    }
  }
  selectors.push(source.slice(start).trim())
  return selectors
}
function pageStyle(source: string): string {
  try {
    const html = document.createElement("html")
    const body = document.createElement("body")
    html.appendChild(body)
    let sheet: CSSStyleSheet | null
    if (typeof CSSStyleSheet !== "undefined" && typeof CSSStyleSheet.prototype.replaceSync === "function") {
      sheet = new CSSStyleSheet()
      sheet.replaceSync(source)
    } else {
      // Detached styles are parsed by older DOM implementations without ever becoming active.
      const style = document.createElement("style")
      style.textContent = source
      sheet = style.sheet
    }
    if (!sheet) return ""
    let rules = 0
    const walk = (list: CSSRuleList, depth = 0): string =>
      [...list]
        .map((rule) => {
          if (++rules > 256 || depth > 4) return ""
          if (rule.type === 1) {
            const item = rule as CSSStyleRule
            if (item.selectorText.length > 1024 || /[\\<@{}]/.test(item.selectorText)) return ""
            const style = safeStyle(item.style)
            const hidden = safeStyle(item.style, "hidden")
            if (!hidden) return style ? `${item.selectorText}{${style}}` : ""
            const visible = safeStyle(item.style, "visible")
            const roots: string[] = [],
              other: string[] = []
            for (const selector of splitSelectors(item.selectorText)) {
              let root = false
              try {
                root = html.matches(selector) || body.matches(selector)
              } catch {}
              if (root) roots.push(selector)
              else other.push(selector)
            }
            return (
              (other.length ? `${other.join(",")}{${style}}` : "") +
              (roots.length && visible ? `${roots.join(",")}{${visible}}` : "") +
              (roots.length
                ? `${roots.map((selector) => `${selector}:where(:not(html,body))`).join(",")}{${hidden}}`
                : "")
            )
          }
          if (rule.type === 4) {
            const item = rule as CSSMediaRule
            const condition = item.conditionText ?? item.media.mediaText
            if (condition.length > 256 || !/^[\w\s():.,<>=/-]+$/.test(condition)) return ""
            return `@media ${condition}{${walk(item.cssRules, depth + 1)}}`
          }
          return ""
        })
        .join("")
    return walk(sheet.cssRules)
  } catch {
    return ""
  }
}
const prefix = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><title>Saved response</title><style>
html{color-scheme:dark}body{margin:0 auto;max-width:72ch;padding:32px 24px;background:#171719;color:#e9e9ec;font:15px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}*{box-sizing:border-box;max-width:100%}h1,h2,h3,h4{line-height:1.3}a{color:#48ce8a}pre,code,kbd,samp{font-family:ui-monospace,monospace}pre{white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #444;padding:8px}blockquote{border-left:2px solid #666;margin-left:0;padding-left:16px}img{display:none}
</style>`

/** Readable offline HTML, rather than replaying an untrusted page in the application WebView. */
export function capturedDocument(source: string): { html: string; limited: boolean } {
  if (source.length > 512 * 1024)
    return {
      html: `${prefix}</head><body><p>This document exceeds the readable preview limit. Use the source preview or saved screenshot.</p></body></html>`,
      limited: true,
    }
  // Template content is inert: no active document, resource loading or custom-element upgrades.
  const template = document.createElement("template")
  template.innerHTML = source
  const styles: string[] = []
  let styleBudget = 64 * 1024
  let limited = false
  for (const style of [...template.content.querySelectorAll("style")].slice(0, 32)) {
    if (styleBudget <= 0) break
    const css = pageStyle((style.textContent ?? "").slice(0, Math.min(16384, styleBudget)))
    if (css.length > styleBudget) {
      limited = true
      continue
    }
    styles.push(css)
    styleBudget -= css.length
  }
  const pageStyles = styles.length ? `<style>${styles.join("")}</style>` : ""
  const chunks: string[] = []
  let remaining = 1024 * 1024 - pageStyles.length
  let count = 0
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
      for (const name of ["id", "class", "title", "lang", "dir", "colspan", "rowspan", "scope"]) {
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
      if (styleBudget > 0 && "style" in element) {
        const style = safeStyle((element as HTMLElement).style)
        if (style && style.length <= styleBudget) {
          attributes.push(` style="${escapeHtml(style)}"`)
          styleBudget -= style.length
        }
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
  return { html: `${prefix}${pageStyles}</head><body>${chunks.join("")}</body></html>`, limited }
}
