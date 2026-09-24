import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Readability } from "@mozilla/readability"
import { PoolExhaustedError } from "@trawl/browser"
import { RequestValidationError, ScrapeError, scrape } from "@trawl/tiers"
import type { ScrapeRequest, ScrapeResult } from "@trawl/types"
import { Elysia } from "elysia"
import { parseHTML } from "linkedom"
import TurndownService from "turndown"
import * as z from "zod/v4"
import pkg from "../../package.json"
import { MCP_ALLOWED_ORIGINS } from "../config"
import { getDeps, getPool } from "../deps"
import { assertPublicHttpUrl, createPublicUrlValidator } from "../outbound-policy"
import { runLoggedScrape } from "../requestLogging"

export const MCP_HTML_MAX_CHARS = 50_000
export const MCP_READ_MAX_CHARS = 100_000

type McpScrapeInput = Pick<
  ScrapeRequest,
  "url" | "maxTimeout" | "maxTier" | "skipHttp" | "screenshot" | "consoleLogs" | "networkLogs" | "redirectChain"
>
type RunScrape = (input: McpScrapeInput) => Promise<ScrapeResult>

interface McpRouteOptions {
  allowedOrigins?: string[]
  poolReady?: () => boolean
  runScrape?: RunScrape
}

const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
const browserTierSchema = z.union([z.literal(2), z.literal(3), z.literal(4)])
const baseInputShape = {
  url: z.string().min(1).describe("Public HTTP(S) URL"),
  maxTimeout: z.number().int().positive().optional().describe("Maximum operation time in milliseconds"),
  maxTier: tierSchema.optional().describe("Highest anti-bot tier TRAWL may use"),
}
const metadataSchema = {
  url: z.string(),
  statusCode: z.number().int(),
  tier: tierSchema,
  contentType: z.string(),
  totalMs: z.number(),
}
const toolAnnotations = { readOnlyHint: true, openWorldHint: true } as const

function errorResult(error: unknown) {
  let message = error instanceof Error ? error.message : String(error)
  if (error instanceof PoolExhaustedError) message = "Browser pool saturated, retry shortly"
  else if (!(error instanceof RequestValidationError || error instanceof ScrapeError)) message = "Scrape failed"
  return { content: [{ type: "text" as const, text: message }], isError: true }
}

function contentType(result: ScrapeResult): string {
  return result.contentType ?? result.responseHeaders?.["content-type"] ?? "text/html"
}

function metadata(result: ScrapeResult) {
  return {
    url: result.url,
    statusCode: result.statusCode,
    tier: result.tier,
    contentType: contentType(result),
    totalMs: result.totalMs,
  }
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return "[invalid URL]"
  }
}

function extractReadable(html: string, url: string, format: "markdown" | "text") {
  const { document } = parseHTML(html)
  const parsed = new Readability(document as unknown as Document).parse()
  const title = parsed?.title?.trim() || document.title?.trim() || url
  const articleHtml = parsed?.content || document.body?.innerHTML || html
  const text =
    format === "markdown"
      ? new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(articleHtml)
      : parsed?.textContent?.trim() || document.body?.textContent?.trim() || ""
  return {
    text,
    title,
    ...(parsed?.byline ? { byline: parsed.byline } : {}),
    ...(parsed?.excerpt ? { excerpt: parsed.excerpt } : {}),
    ...(parsed?.siteName ? { siteName: parsed.siteName } : {}),
    ...(parsed?.lang ? { language: parsed.lang } : {}),
  }
}

function createServer(poolReady: () => boolean, runScrape: RunScrape): McpServer {
  const server = new McpServer(
    { name: "trawl", version: pkg.version },
    {
      instructions:
        "Use read for concise article content, scrape for source HTML, screenshot for visual inspection, and inspect for browser diagnostics. TRAWL fetches known URLs; it does not search the web.",
    },
  )

  const runSafe = async (input: McpScrapeInput) => {
    await assertPublicHttpUrl(input.url)
    if (!poolReady()) throw new Error("Browser pool initializing, retry in a few seconds")
    const result = await runScrape(input)
    await assertPublicHttpUrl(result.url)
    return result
  }

  const scrapeHandler = async (input: {
    url: string
    maxTimeout?: number
    maxTier?: 1 | 2 | 3 | 4
    skipHttp?: boolean
  }) => {
    try {
      const result = await runSafe(input)
      const truncated = result.html.length > MCP_HTML_MAX_CHARS
      const html = result.html.slice(0, MCP_HTML_MAX_CHARS)
      const structuredContent = {
        ...metadata(result),
        truncated,
        sessionCached: result.sessionCached,
        timings: result.timings,
        ...(result.captchasSolved ? { captchasSolved: result.captchasSolved } : {}),
        ...(result.proxyUsed === undefined ? {} : { proxyUsed: result.proxyUsed }),
      }
      return { content: [{ type: "text" as const, text: html }], structuredContent }
    } catch (error) {
      return errorResult(error)
    }
  }

  const scrapeConfig = {
    title: "Scrape page",
    description:
      "Fetch source HTML from a known public URL through TRAWL's anti-bot tiers. Prefer read when the user wants page content rather than markup.",
    inputSchema: z.strictObject({
      ...baseInputShape,
      skipHttp: z.boolean().optional().describe("Skip the plain HTTP tier and start with a browser"),
    }),
    outputSchema: {
      ...metadataSchema,
      truncated: z.boolean(),
      sessionCached: z.boolean(),
      timings: z.array(
        z.object({
          tier: tierSchema,
          status: z.enum(["success", "blocked", "needs-js", "timeout", "error", "skipped"]),
          durationMs: z.number(),
          reason: z.string().optional(),
        }),
      ),
      captchasSolved: z.array(z.string()).optional(),
      proxyUsed: z.boolean().optional(),
    },
    annotations: toolAnnotations,
  }
  server.registerTool("scrape", scrapeConfig, scrapeHandler)
  server.registerTool(
    "scrape_url",
    {
      ...scrapeConfig,
      title: "Scrape URL (compatibility alias)",
      description: "Compatibility alias for scrape. Fetch source HTML from a known public URL.",
    },
    scrapeHandler,
  )

  server.registerTool(
    "read",
    {
      title: "Read page",
      description:
        "Extract the main human-readable content from a known public URL. Use this for articles, documentation and research.",
      inputSchema: z.strictObject({
        ...baseInputShape,
        format: z.enum(["markdown", "text"]).optional().describe("Output format; defaults to markdown"),
        maxCharacters: z
          .number()
          .int()
          .min(1)
          .max(MCP_READ_MAX_CHARS)
          .optional()
          .describe(`Maximum returned characters; defaults to ${MCP_HTML_MAX_CHARS}`),
      }),
      outputSchema: {
        ...metadataSchema,
        title: z.string(),
        format: z.enum(["markdown", "text"]),
        characters: z.number().int(),
        truncated: z.boolean(),
        byline: z.string().optional(),
        excerpt: z.string().optional(),
        siteName: z.string().optional(),
        language: z.string().optional(),
      },
      annotations: toolAnnotations,
    },
    async ({ format = "markdown", maxCharacters = MCP_HTML_MAX_CHARS, ...input }) => {
      try {
        const result = await runSafe(input)
        const readable = extractReadable(result.html, result.url, format)
        const truncated = readable.text.length > maxCharacters
        const text = readable.text.slice(0, maxCharacters)
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            ...metadata(result),
            title: readable.title,
            format,
            characters: text.length,
            truncated,
            ...(readable.byline ? { byline: readable.byline } : {}),
            ...(readable.excerpt ? { excerpt: readable.excerpt } : {}),
            ...(readable.siteName ? { siteName: readable.siteName } : {}),
            ...(readable.language ? { language: readable.language } : {}),
          },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot page",
      description:
        "Render a known public URL in TRAWL's browser and return a viewport JPEG for visual or multimodal inspection.",
      inputSchema: z.strictObject({
        ...baseInputShape,
        maxTier: browserTierSchema.optional().describe("Highest browser tier TRAWL may use"),
      }),
      outputSchema: { ...metadataSchema, mimeType: z.literal("image/jpeg") },
      annotations: toolAnnotations,
    },
    async (input) => {
      try {
        const result = await runSafe({ ...input, skipHttp: true, screenshot: true })
        if (!result.screenshot) throw new ScrapeError("Screenshot capture failed", result.timings)
        return {
          content: [{ type: "image", data: result.screenshot, mimeType: "image/jpeg" }],
          structuredContent: { ...metadata(result), mimeType: "image/jpeg" as const },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "inspect",
    {
      title: "Inspect page",
      description:
        "Load a known public URL in a browser and return bounded console, network and redirect diagnostics. Use for web debugging, not ordinary reading.",
      inputSchema: z.strictObject({
        ...baseInputShape,
        maxTier: browserTierSchema.optional().describe("Highest browser tier TRAWL may use"),
      }),
      outputSchema: {
        ...metadataSchema,
        consoleLogs: z.array(
          z.object({
            level: z.enum(["SEVERE", "WARNING", "INFO", "DEBUG"]),
            message: z.string(),
            timestamp: z.number(),
            source: z.string(),
          }),
        ),
        networkLogs: z.array(
          z.object({
            name: z.string(),
            entryType: z.enum(["navigation", "resource"]),
            startTime: z.number(),
            duration: z.number(),
            initiatorType: z.string(),
            transferSize: z.number().nullable(),
            encodedBodySize: z.number().nullable(),
            decodedBodySize: z.number().nullable(),
          }),
        ),
        redirectChain: z.array(z.string()),
      },
      annotations: toolAnnotations,
    },
    async (input) => {
      try {
        const result = await runSafe({
          ...input,
          skipHttp: true,
          consoleLogs: true,
          networkLogs: true,
          redirectChain: true,
        })
        const structuredContent = {
          ...metadata(result),
          consoleLogs: result.consoleLogs ?? [],
          networkLogs: (result.networkLogs ?? []).map((entry) => ({ ...entry, name: redactUrl(entry.name) })),
          redirectChain: (result.redirectChain ?? []).map(redactUrl),
        }
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  return server
}

export function mcpRoute({
  allowedOrigins = MCP_ALLOWED_ORIGINS,
  poolReady = () => Boolean(getPool()),
  runScrape = (input) => {
    const validateOutboundUrl = createPublicUrlValidator()
    const deps = {
      ...getDeps(),
      validateOutboundUrl: async (url: string) => void (await validateOutboundUrl(url)),
    }
    return runLoggedScrape("mcp", input, deps, scrape)
  },
}: McpRouteOptions = {}) {
  const origins = new Set(allowedOrigins)
  const handle = async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin")
    if (origin && !origins.has(origin)) {
      return Response.json({ error: "Origin not allowed" }, { status: 403 })
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    const server = createServer(poolReady, runScrape)
    try {
      await server.connect(transport)
      return await transport.handleRequest(request)
    } catch {
      await server.close().catch(() => {})
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
        { status: 500 },
      )
    }
  }
  return new Elysia().get("/mcp", ({ request }) => handle(request)).post("/mcp", ({ request }) => handle(request))
}
