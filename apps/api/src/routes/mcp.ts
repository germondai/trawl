import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Readability } from "@mozilla/readability"
import { PoolExhaustedError } from "@trawl/browser"
import { isHtmlContentType, RequestValidationError, ScrapeError, scrape } from "@trawl/tiers"
import type { ScrapeRequest, ScrapeResult } from "@trawl/types"
import { Elysia } from "elysia"
import { parseHTML } from "linkedom"
import TurndownService from "turndown"
import * as z from "zod/v4"
import pkg from "../../package.json"
import { MCP_ALLOWED_ORIGINS } from "../config"
import { getDeps, getPool } from "../deps"
import { extractFields } from "../mcpExtraction"
import { type MetricsStore, metrics } from "../metrics"
import { assertPublicHttpUrl, createPublicUrlValidator } from "../outbound-policy"
import { runLoggedScrape } from "../requestLogging"

export const MCP_HTML_MAX_CHARS = 50_000
export const MCP_READ_MAX_CHARS = 100_000

type McpScrapeInput = Pick<
  ScrapeRequest,
  | "sessionId"
  | "url"
  | "maxTimeout"
  | "maxTier"
  | "skipHttp"
  | "screenshot"
  | "screenshotFullPage"
  | "screenshotWaitForSelector"
  | "screenshotSelector"
  | "contentWaitForSelector"
  | "consoleLogs"
  | "networkLogs"
  | "redirectChain"
>
type RunScrape = (input: McpScrapeInput) => Promise<ScrapeResult>

interface McpRouteOptions {
  allowedOrigins?: string[]
  poolReady?: () => boolean
  runScrape?: RunScrape
  metricsStore?: MetricsStore
}

const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
const browserTierSchema = z.union([z.literal(2), z.literal(3), z.literal(4)])
const baseInputShape = {
  sessionId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .optional()
    .describe("Existing browser session created through POST /sessions"),
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
const fieldSchema = z.strictObject({
  selector: z.string().min(1).max(500).describe("CSS selector relative to each item"),
  attribute: z.string().min(1).max(64).optional().describe("HTML attribute to return; defaults to text content"),
})

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

function createServer(poolReady: () => boolean, runScrape: RunScrape, metricsStore: MetricsStore): McpServer {
  const server = new McpServer(
    { name: "trawl", version: pkg.version },
    {
      instructions:
        "Use read for article content, scrape for source HTML, extract for CSS-selected JSON records, screenshot for visual inspection, and inspect for browser diagnostics. TRAWL fetches known URLs; it does not search the web.",
    },
  )

  const runSafe = async (input: McpScrapeInput) => {
    const started = Date.now()
    let scraperStarted = false
    try {
      await assertPublicHttpUrl(input.url)
      if (!poolReady()) throw new Error("Browser pool initializing, retry in a few seconds")
      scraperStarted = true
      const result = await runScrape(input)
      await assertPublicHttpUrl(result.url)
      return result
    } catch (error) {
      if (!scraperStarted) {
        metricsStore.record({
          source: "mcp",
          url: input.url,
          durationMs: Date.now() - started,
          statusCode: error instanceof RequestValidationError ? error.statusCode : 503,
          error,
        })
      }
      throw error
    }
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
        timings: result.timings.map(({ tier, status, durationMs, reason }) => ({
          tier,
          status,
          durationMs,
          ...(reason === undefined ? {} : { reason }),
        })),
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
        // Plain-text documents have no article to extract;
        // readability parsing would mangle them, so pass the text through untouched.
        const article = isHtmlContentType(contentType(result))
          ? extractReadable(result.html, result.url, format)
          : undefined
        const title = article?.title ?? result.url
        const fullText = article?.text ?? result.html
        const truncated = fullText.length > maxCharacters
        const text = fullText.slice(0, maxCharacters)
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            ...metadata(result),
            title,
            format,
            characters: text.length,
            truncated,
            ...(article?.byline ? { byline: article.byline } : {}),
            ...(article?.excerpt ? { excerpt: article.excerpt } : {}),
            ...(article?.siteName ? { siteName: article.siteName } : {}),
            ...(article?.language ? { language: article.language } : {}),
          },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    "extract",
    {
      title: "Extract page fields",
      description:
        "Extract bounded JSON records from a known public page using CSS selectors. Set itemSelector for a repeated list; field selectors are relative to each item.",
      inputSchema: z.strictObject({
        ...baseInputShape,
        render: z.boolean().optional().describe("Start with a browser tier so JavaScript can render page content"),
        waitForSelector: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("Wait up to 10 seconds for a visible CSS selector before reading browser HTML; implies render"),
        itemSelector: z.string().min(1).max(500).optional().describe("CSS selector matching repeated items"),
        fields: z
          .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), fieldSchema)
          .refine((fields) => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 20, {
            message: "Provide 1 to 20 fields",
          }),
        maxItems: z.number().int().min(1).max(100).optional().describe("Maximum records; defaults to 25"),
      }),
      outputSchema: {
        ...metadataSchema,
        items: z.array(z.record(z.string(), z.string().nullable())),
        matched: z.number().int(),
        truncated: z.boolean(),
      },
      annotations: toolAnnotations,
    },
    async ({ render, waitForSelector, itemSelector, fields, maxItems = 25, ...input }) => {
      try {
        if ((render || waitForSelector) && input.maxTier === 1) {
          throw new RequestValidationError("Browser rendering requires maxTier 2 or higher", 400)
        }
        const result = await runSafe({
          ...input,
          ...(render || waitForSelector ? { skipHttp: true } : {}),
          ...(waitForSelector ? { contentWaitForSelector: waitForSelector } : {}),
        })
        const extracted = extractFields(result.html, itemSelector, fields, maxItems)
        return {
          content: [{ type: "text", text: JSON.stringify(extracted.items) }],
          structuredContent: { ...metadata(result), ...extracted },
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
      description: "Render a known public URL and return a JPEG of the viewport, full page, or first matching element.",
      inputSchema: z.strictObject({
        ...baseInputShape,
        maxTier: browserTierSchema.optional().describe("Highest browser tier TRAWL may use"),
        selector: z.string().min(1).max(500).optional().describe("Capture the first visible matching element"),
        fullPage: z
          .boolean()
          .optional()
          .describe("Capture the entire page, up to 6000 pixels tall and 12 million pixels"),
        waitForSelector: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("Wait up to 10 seconds for a visible CSS selector"),
      }),
      outputSchema: { ...metadataSchema, mimeType: z.literal("image/jpeg") },
      annotations: toolAnnotations,
    },
    async ({ selector, fullPage, waitForSelector, ...input }) => {
      try {
        if (selector && fullPage) {
          throw new RequestValidationError("selector cannot be combined with fullPage", 400)
        }
        const result = await runSafe({
          ...input,
          skipHttp: true,
          screenshot: true,
          ...(fullPage === undefined ? {} : { screenshotFullPage: fullPage }),
          ...(waitForSelector === undefined ? {} : { screenshotWaitForSelector: waitForSelector }),
          ...(selector === undefined ? {} : { screenshotSelector: selector }),
        })
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
  metricsStore = metrics,
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
    const server = createServer(poolReady, runScrape, metricsStore)
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
