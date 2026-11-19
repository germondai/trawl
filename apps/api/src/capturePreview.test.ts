import { expect, test } from "bun:test"
import { parseHTML } from "linkedom"
import { capturedDocument } from "../../desktop/app/utils/captured-document"

test("readable saved HTML removes active content, outbound resources and native access before sandboxing", () => {
  const { document, Node } = parseHTML("<!doctype html><html><body></body></html>")
  const names = ["document", "Node"] as const
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Reflect.set(globalThis, "document", document)
  Reflect.set(globalThis, "Node", Node)
  try {
    const preview = capturedDocument(
      `<html><head><base href="https://owned.invalid/"><meta http-equiv="refresh" content="0;url=/dummy-resource"><style>body{background:url('/dummy-resource')}</style></head><body><h1 id="named" onclick="window.dummy=1">Owned title</h1><p>Readable &amp; safe</p><script>window.dummy=1</script><img src="/dummy-resource" alt="Saved image" onerror="window.dummy=1"><iframe src="/dummy-resource"></iframe><form action="/dummy-resource"><input autofocus><button>Submit</button></form><svg><foreignObject><img src="/dummy-resource"></foreignObject></svg><a href="/dummy-resource" target="_top">Inactive link</a><div style="background:red">Body text</div></body></html>`,
    )
    expect(preview.limited).toBe(false)
    expect(preview.html).toContain("Owned title")
    expect(preview.html).toContain("[Saved image]")
    expect(preview.html).not.toMatch(/dummy-resource|onclick|window\.dummy|__TAURI/)
    expect(preview.html).toContain("default-src 'none'")
    const body = parseHTML(preview.html).document.body
    expect(body.querySelectorAll("script,style,iframe,form,input,button,img,svg,object,embed").length).toBe(0)
    expect(body.querySelectorAll("[href],[src],[name],[onerror]").length).toBe(0)
    expect(body.querySelector("h1")?.textContent).toBe("Owned title")
    expect(body.querySelector("h1")?.id).toBe("named")
    expect(body.querySelector("div")?.getAttribute("style")).toContain("background:red")
    const styled = capturedDocument(
      '<style>body{max-width:26em;margin:auto;text-align:center;background:url(https://dummy-resource)} @import "https://dummy-resource"; .card{display:flex;gap:12px;animation:spin 1s infinite}</style><div class="card" style="padding:24px;background-image:u\\72l(https://dummy-resource)">Styled preview</div>',
    )
    expect(styled.html).toContain("max-width:26em")
    expect(styled.html).toContain("text-align:center")
    expect(styled.html).toContain("gap:12px")
    expect(styled.html).toContain('class="card"')
    expect(styled.html).not.toMatch(/dummy-resource|@import|animation:spin|background-image/)

    const gated = capturedDocument(
      "<style>body{display:none !important;visibility:hidden;opacity:0;color:red}.hidden{display:none}</style><h1>Script-gated content</h1>",
    )
    expect(gated.html).toContain("Script-gated content")
    expect(gated.html).toContain("body{color:red}")
    expect(gated.html).toContain(".hidden{display:none}")
    const combined = capturedDocument(
      '<style>body,.hidden{display:none !important;color:red}</style><h1>Visible</h1><p class="hidden">Hidden</p>',
    )
    expect(combined.html).toContain("body{color:red}")
    expect(combined.html).toContain(".hidden{display:none !important;color:red}")
    const cascade = capturedDocument(
      '<style>body{display:none;color:red}body{color:blue}:is(body,.hidden){opacity:0}body,[title="a,b"]{visibility:hidden}</style><h1>Visible</h1>',
    )
    expect(cascade.html).toContain("body{color:red}")
    expect(cascade.html).toContain("body{color:blue}")
    expect(cascade.html.replace(/,\s+/g, ",")).toContain(":is(body,.hidden):where(:not(html,body)){opacity:0}")
    expect(cascade.html).toContain('[title="a,b"]{visibility:hidden}')
    const selectors = ["body", ...Array.from({ length: 100 }, (_, i) => `.s${i}`)].join(",")
    const manySelectors = capturedDocument(
      `${`<style>${selectors}{display:none;font-family:${"f".repeat(1000)}}</style>`.repeat(32)}<p>Bounded content</p>`,
    )
    expect(manySelectors.html.length).toBeLessThan(70000)
    expect(manySelectors.html).toContain("Bounded content")
    expect(manySelectors.limited).toBe(true)

    expect(capturedDocument("x".repeat(600000)).limited).toBe(true)
    const deep = capturedDocument(`${"<div>".repeat(1000)}text${"</div>".repeat(1000)}`)
    expect(deep.limited).toBe(true)
    expect(deep.html.length).toBeLessThan(10000)
    const wide = capturedDocument("<b>text</b>".repeat(10000))
    expect(wide.limited).toBe(true)
    expect(wide.html.length).toBeLessThan(1024 * 1024 + 5000)
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
