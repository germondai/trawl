import process from "node:process"
import { type ReadResponse, Trawl, TrawlError } from "@trawl/client"

const client = new Trawl({
  baseURL: process.env.TRAWL_BASE_URL || "http://localhost:8191",
  apiKey: process.env.TRAWL_API_KEY || undefined,
  timeoutMs: 70_000,
})
const source = process.env.TRAWL_SOURCE_URL || "https://example.com"
type Article = Pick<ReadResponse, "title" | "text" | "url" | "format" | "truncated">
let cached: { expiresAt: number; article: Article } | undefined
let pending: Promise<Article> | undefined

async function getArticle(): Promise<Article> {
  if (cached && cached.expiresAt > Date.now()) return cached.article
  pending ??= client
    .read({ url: source, maxTimeout: 60_000, maxCharacters: 20_000 })
    .then((result) => {
      const article: Article = {
        title: result.title,
        text: result.text,
        url: result.url,
        format: result.format,
        truncated: result.truncated,
      }
      cached = { expiresAt: Date.now() + 60_000, article }
      return article
    })
    .finally(() => {
      pending = undefined
    })
  return pending
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>TRAWL client demo</title>
<body><button id="load">Load article</button><h1 id="title"></h1><pre id="content"></pre>
<script>
document.getElementById("load").addEventListener("click", async () => {
  const output = document.getElementById("content");
  try {
    const response = await fetch("/article");
    if (!response.ok) throw new Error("Fetch failed");
    const article = await response.json();
    document.getElementById("title").textContent = article.title;
    output.textContent = article.text;
  } catch { output.textContent = "Could not load the article."; }
});
</script></body></html>`

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 3400),
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    if (path !== "/article") return new Response("Not found", { status: 404 })
    try {
      return Response.json(await getArticle())
    } catch (error) {
      console.error("Article fetch failed", { kind: error instanceof TrawlError ? error.kind : "unexpected" })
      return Response.json({ error: "Could not load article" }, { status: 502 })
    }
  },
})
console.log(`Open ${server.url}`)
