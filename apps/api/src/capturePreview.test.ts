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
    expect(body.querySelectorAll("[href],[src],[style],[id],[name],[onerror]").length).toBe(0)
    expect(body.querySelector("h1")?.textContent).toBe("Owned title")
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
