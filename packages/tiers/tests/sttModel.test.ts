import { afterEach, describe, expect, test } from "bun:test"

const realFetch = globalThis.fetch
const saved = { url: process.env.STT_URL, model: process.env.STT_MODEL, key: process.env.STT_API_KEY }

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [name, value] of [
    ["STT_URL", saved.url],
    ["STT_MODEL", saved.model],
    ["STT_API_KEY", saved.key],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

// STT_URL and STT_MODEL are read when the module loads, so each case imports a fresh copy.
let copy = 0
async function loadStt(env: Record<string, string>) {
  Object.assign(process.env, env)
  return (await import(`../src/solvers/stt?case=${++copy}`)) as typeof import("../src/solvers/stt")
}

function captureFetch(reply: string) {
  const seen: { url: string; form?: FormData; headers?: Record<string, string> } = { url: "" }
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url)
    seen.form = init?.body as FormData
    seen.headers = init?.headers as Record<string, string>
    return new Response(reply)
  }) as typeof fetch
  return seen
}

describe("STT_MODEL for in-memory audio", () => {
  test("sends the configured model and keeps the container extension in the file name", async () => {
    const stt = await loadStt({ STT_URL: "http://stt.test/v1/audio/transcriptions", STT_MODEL: "qwen-asr" })
    const seen = captureFetch("Type one of the two following words spoken by me. Target. Knowledge.")

    const text = await stt.transcribeAudioBytes(new Uint8Array([1, 2, 3, 4]))

    expect(seen.url).toBe("http://stt.test/v1/audio/transcriptions")
    expect(seen.form?.get("model")).toBe("qwen-asr")
    expect((seen.form?.get("file") as File | null)?.name).toBe("audio.aac")
    expect(seen.form?.get("response_format")).toBe("text")
    expect(text).toBe("type one of the two following words spoken by me. target. knowledge.")
  })

  test("defaults to whisper-1 when STT_MODEL is unset", async () => {
    delete process.env.STT_MODEL
    const stt = await loadStt({ STT_URL: "http://stt.test/v1/audio/transcriptions" })
    const seen = captureFetch("ok")

    await stt.transcribeAudioBytes(new Uint8Array([1]), undefined, "clip.wav")

    expect(seen.form?.get("model")).toBe("whisper-1")
    expect((seen.form?.get("file") as File | null)?.name).toBe("clip.wav")
  })

  test("sends the bearer key only to the configured endpoint", async () => {
    const stt = await loadStt({ STT_URL: "http://stt.test/x", STT_API_KEY: "secret" })
    const seen = captureFetch("ok")

    await stt.transcribeAudioBytes(new Uint8Array([1]))

    expect(seen.headers?.Authorization).toBe("Bearer secret")
  })

  test("returns nothing when the recogniser answers with an error", async () => {
    const stt = await loadStt({ STT_URL: "http://stt.test/x" })
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch

    expect(await stt.transcribeAudioBytes(new Uint8Array([1]))).toBeUndefined()
  })
})
