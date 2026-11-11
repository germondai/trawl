import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { PoolExhaustedError } from "@trawl/browser"
import { type OrchestratorDeps, RequestValidationError, ScrapeError, scrape } from "@trawl/tiers"
import type { ScrapeRequest, ScrapeResult } from "@trawl/types"
import { Elysia } from "elysia"
import * as z from "zod/v4"
import pkg from "../../package.json"
import { MCP_ALLOWED_ORIGINS } from "../config"
import { getDeps, getPool, publicEgress } from "../deps"
import { type MetricsStore, metrics } from "../metrics"
import { assertPublicHttpUrl, parsePublicHttpUrl } from "../outbound-policy"
import { extractPage, pageMetadata as metadata, READ_MAX_CHARACTERS, readPage } from "../pageContent"
import { extractionOptionsShape, prepareExtractionRequest, readOptionsShape } from "../pageContent/options"
import { runLoggedScrape } from "../requestLogging"

export const MCP_HTML_MAX_CHARS = 50_000
export const MCP_READ_MAX_CHARS = READ_MAX_CHARACTERS

type McpScrapeInput = Pick<
  ScrapeRequest,
  | "sessionId"
  | "url"
  | "maxTimeout"
  | "maxTier"
  | "skipHttp"
  | "solveEmbeddedCaptchas"
  | "screenshot"
  | "screenshotFullPage"
  | "screenshotWaitForSelector"
  | "screenshotSelector"
  | "contentWaitForSelector"
  | "consoleLogs"
  | "networkLogs"
  | "detectWaf"
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
  detectWaf: z.boolean().optional().describe("Identify WAF providers offline; enabled by default, false opts out"),
  sessionId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .optional()
    .describe("Existing publicOnly browser session created through POST /sessions"),
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
  waf: z
    .object({
      engine: z.literal("wafmeow"),
      version: z.string(),
      state: z.enum(["complete", "incomplete", "unavailable"]),
      products: z.array(z.string()),
      matches: z
        .array(
          z.object({
            product: z.string(),
            schema: z.number().int().positive(),
            fingerprints: z
              .array(z.object({ fingerprint: z.number().int().positive(), evidence: z.literal(0) }))
              .max(16),
          }),
        )
        .max(32)
        .optional(),
      incompleteProducts: z.array(z.string()).max(256).optional(),
      diagnostics: z
        .array(
          z.object({
            code: z.enum([
              "body_truncated",
              "missing_response",
              "invalid_engine",
              "invalid_evidence",
              "transport_error",
            ]),
            evidence: z.union([z.literal(0), z.literal(-1)]),
          }),
        )
        .max(16)
        .optional(),
      detailsTruncated: z.boolean().optional(),
      sourceTier: tierSchema.optional(),
      durationMs: z.number().nonnegative().optional(),
      reason: z.enum(["not-installed", "timeout", "busy", "failed", "no-response"]).optional(),
    })
    .optional(),
}
const toolAnnotations = { readOnlyHint: true, openWorldHint: true } as const
function errorResult(error: unknown) {
  let message = error instanceof Error ? error.message : String(error)
  if (error instanceof PoolExhaustedError) message = "Browser pool saturated, retry shortly"
  else if (!(error instanceof RequestValidationError || error instanceof ScrapeError)) message = "Scrape failed"
  if (error instanceof ScrapeError && error.waf) message += `\nWAF detection: ${JSON.stringify(error.waf)}`
  return { content: [{ type: "text" as const, text: message }], isError: true }
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
    solveEmbeddedCaptchas?: boolean
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
      solveEmbeddedCaptchas: z
        .boolean()
        .optional()
        .describe("Attempt embedded form widgets after clearing access challenges; defaults to true"),
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
      inputSchema: z.strictObject({ ...baseInputShape, ...readOptionsShape }),
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
        const { text, ...structuredContent } = readPage(result, { format, maxCharacters })
        return { content: [{ type: "text", text }], structuredContent }
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
        ...extractionOptionsShape,
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
        const result = await runSafe(
          prepareExtractionRequest({
            ...input,
            ...(render === undefined ? {} : { render }),
            ...(waitForSelector ? { contentWaitForSelector: waitForSelector } : {}),
          }),
        )
        const extracted = extractPage(result, { itemSelector, fields, maxItems })
        return {
          content: [{ type: "text", text: JSON.stringify(extracted.items) }],
          structuredContent: { ...extracted },
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

export function runMcpScrape(input: McpScrapeInput, deps: OrchestratorDeps = getDeps()): Promise<ScrapeResult> {
  return runLoggedScrape(
    "mcp",
    input,
    {
      ...deps,
      loadSession: (domain) => deps.loadSession(`mcp:${domain}`),
      saveSession: (domain, data) => deps.saveSession(`mcp:${domain}`, data),
      invalidateSession: (domain) => deps.invalidateSession(`mcp:${domain}`),
      // URL syntax is checked here; the egress proxy resolves and pins every actual connection.
      validateOutboundUrl: async (url: string) => void parsePublicHttpUrl(url),
      networkProxy: deps.networkProxy ?? ((upstream?: string) => publicEgress.proxyFor(upstream)),
    },
    scrape,
  )
}

export function mcpRoute({
  allowedOrigins = MCP_ALLOWED_ORIGINS,
  poolReady = () => Boolean(getPool()),
  metricsStore = metrics,
  runScrape = runMcpScrape,
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
