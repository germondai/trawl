import { createHash } from "node:crypto"
import { parseHTML } from "linkedom"
import { detectAnubisPage } from "./anubis"
import { runPowProcess } from "./powProcess"

export interface PowPlan {
  kind: string
  // Milliseconds the server requires between issuing and submitting.
  waitMs: number
  submit: (
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<{ url: string; method: "GET" | "POST"; body?: string; contentType?: string } | undefined>
}

export function looksLikePowWall(html: string): boolean {
  return html.includes("/_pow/solve") || html.includes("anubis_challenge")
}

const ALGO = { sha256: 0, argon2id: 1, hashx: 2 } as const
async function solve(
  algorithm: number,
  data: string,
  bits: number,
  timeoutMs = 1000,
  signal?: AbortSignal,
): Promise<{ nonce: number; hash: string } | undefined> {
  const result = (await runPowProcess({ algorithm, data, bits }, timeoutMs, signal)) as
    | { nonce?: unknown; hash?: unknown }
    | undefined
  if (
    result &&
    typeof result.nonce === "number" &&
    Number.isInteger(result.nonce) &&
    result.nonce >= 0 &&
    result.nonce <= 0xffffffff &&
    typeof result.hash === "string" &&
    /^[a-f0-9]{64}$/.test(result.hash)
  ) {
    return { nonce: result.nonce, hash: result.hash }
  }
}

/** Image builds must exercise the native ABI rather than silently using JS. */
export async function verifyNativePow(): Promise<void> {
  for (const algorithm of [0, 1, 2]) {
    const result = await solve(algorithm, "12345699", 0)
    if (result?.nonce !== 0) throw new Error("Native proof-of-work solver unavailable")
    if (algorithm === 0) {
      const expected = createHash("sha256").update(Buffer.from("1234569900000000", "hex")).digest("hex")
      if (result.hash !== expected) throw new Error("Native SHA-256 proof does not match the protocol")
    }
  }
  const puzzle = Buffer.alloc(32)
  puzzle[12] = 1
  puzzle[14] = 1
  puzzle[15] = 1
  const input = `native-check.${puzzle.toString("base64")}`
  const proof = await runPowProcess({ task: "friendly-captcha", puzzle: input, nativeOnly: true })
  if (typeof proof !== "string" || !proof.startsWith(`${input}.`))
    throw new Error("Native Friendly Captcha solver unavailable")
}

const jsonScript = (document: ReturnType<typeof parseHTML>["document"], id: string): unknown => {
  const script = document.getElementById(id)
  if (script?.tagName !== "SCRIPT" || script.getAttribute("type") !== "application/json") return null
  try {
    return JSON.parse(script.textContent ?? "")
  } catch {
    return null
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
}
function bitsValid(bits: number): boolean {
  return Number.isInteger(bits) && bits >= 0 && bits <= 256
}

function planNcbi(script: string, pageUrl: string): PowPlan | undefined {
  const id = script.match(/const\s+challengeId\s*=\s*"([^"]+)"/)?.[1]
  const bits = Number(script.match(/const\s+bits\s*=\s*(\d+)\s*;/)?.[1])
  if (!text(id) || !Number.isFinite(bits) || !script.includes("/_pow/solve")) return undefined
  return {
    kind: `ncbi-pow(bits=${bits})`,
    waitMs: 0,
    submit: async (timeoutMs, signal) => {
      if (!bitsValid(bits)) return
      const solved = await solve(-1, `${id}:`, bits, timeoutMs, signal)
      if (!solved) return undefined
      return {
        url: new URL("/_pow/solve", pageUrl).href,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ challenge_id: id, nonce: String(solved.nonce), redirect_url: pageUrl }),
      }
    },
  }
}

function planAnubis(
  html: string,
  pageUrl: string,
  document: ReturnType<typeof parseHTML>["document"],
): PowPlan | undefined {
  if (detectAnubisPage(html) !== "challenge") return
  const data = jsonScript(document, "anubis_challenge") as {
    challenge?: { id?: string; randomData?: string }
    rules?: { algorithm?: string; difficulty?: number }
  } | null
  const id = data?.challenge?.id
  const randomData = data?.challenge?.randomData
  const algorithm = data?.rules?.algorithm
  const difficulty = data?.rules?.difficulty
  if (!text(id) || !text(randomData) || !text(algorithm) || typeof difficulty !== "number" || !bitsValid(difficulty))
    return undefined
  if (!["fast", "slow", "sha256", "argon2id", "hashx", "preact", "metarefresh"].includes(algorithm)) return

  const basePrefix = jsonScript(document, "anubis_base_prefix") ?? ""
  if (
    typeof basePrefix !== "string" ||
    (basePrefix !== "" && !/^\/(?!\/)/.test(basePrefix)) ||
    /[\\?#]/.test(basePrefix)
  )
    return
  const publicUrl = jsonScript(document, "anubis_public_url")
  if (publicUrl !== null && typeof publicUrl !== "string") return
  const page = new URL(pageUrl)
  const passUrl = new URL(`${basePrefix}/.within.website/x/cmd/anubis/api/pass-challenge`, page.origin)
  if (passUrl.origin !== page.origin) return
  // Mirrors getRedirectUrl() in Anubis' web/js/main.ts.
  const redir =
    publicUrl === null
      ? "/"
      : publicUrl && pageUrl.startsWith(publicUrl)
        ? (page.searchParams.get("redir") ?? "/")
        : pageUrl
  const started = Date.now()

  if (algorithm === "preact" || algorithm === "metarefresh") {
    const perStep = algorithm === "preact" ? 80 : 800
    return {
      kind: `anubis-${algorithm}(difficulty=${difficulty})`,
      waitMs: difficulty * perStep + 150,
      submit: async () => {
        // Server-side pages set redir to the request URI.
        passUrl.searchParams.set("redir", page.pathname + page.search)
        passUrl.searchParams.set("id", id)
        if (algorithm === "preact")
          passUrl.searchParams.set("result", createHash("sha256").update(randomData).digest("hex"))
        else passUrl.searchParams.set("challenge", randomData)
        return { url: passUrl.href, method: "GET" }
      },
    }
  }

  const bits = algorithm === "fast" || algorithm === "slow" ? difficulty * 4 : difficulty
  if (!bitsValid(bits)) return
  const algo = algorithm === "fast" || algorithm === "slow" ? -1 : ALGO[algorithm as keyof typeof ALGO]
  if (algo === undefined || (algo !== -1 && (!/^[0-9a-f]+$/i.test(randomData) || randomData.length % 2))) return

  return {
    kind: `anubis-${algorithm}(difficulty=${difficulty})`,
    waitMs: 0,
    submit: async (timeoutMs, signal) => {
      const solved = await solve(algo, randomData, bits, timeoutMs, signal)
      if (!solved) return undefined
      passUrl.searchParams.set("id", id)
      passUrl.searchParams.set("response", solved.hash)
      passUrl.searchParams.set("nonce", String(solved.nonce))
      passUrl.searchParams.set("redir", redir)
      passUrl.searchParams.set("elapsedTime", String(Math.max(1, Date.now() - started)))
      return { url: passUrl.href, method: "GET" }
    },
  }
}

export function planPowWall(html: string, pageUrl: string): PowPlan | undefined {
  if (html.length > 262_144 || !looksLikePowWall(html)) return undefined
  const { document } = parseHTML(html)
  for (const node of document.querySelectorAll("template, noscript")) node.remove()
  const scripts = [...document.querySelectorAll("script")]
    .filter(
      (node) =>
        !node.hasAttribute("src") &&
        (!node.getAttribute("type") || /^(?:text|application)\/javascript$/i.test(node.getAttribute("type") ?? "")),
    )
    .map((node) => node.textContent ?? "")
    .join("\n")
  return planNcbi(scripts, pageUrl) ?? planAnubis(html, pageUrl, document)
}
