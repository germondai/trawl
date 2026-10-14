import { BROWSER_PROFILES, createClient, getProfiles } from "node-wreq"

export function selectLatestFirefoxProfile<Profile extends string>(profiles: readonly Profile[]): Profile {
  let latest: Profile | undefined
  let latestVersion = -1
  for (const profile of profiles) {
    const match = /^firefox_(\d+)$/.exec(profile)
    if (!match) continue
    const version = Number(match[1])
    if (version > latestVersion) {
      latest = profile
      latestVersion = version
    }
  }
  if (!latest) throw new Error("No supported Firefox TLS profile available")
  return latest
}

export const TLS_PROFILE = selectLatestFirefoxProfile(BROWSER_PROFILES)
const firefoxVersion = TLS_PROFILE.slice("firefox_".length)
export const TIER1_USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64; rv:${firefoxVersion}.0) Gecko/20100101 Firefox/${firefoxVersion}.0`

let client: ReturnType<typeof createClient> | undefined

function getClient() {
  if (!client) {
    if (!getProfiles().includes(TLS_PROFILE)) throw new Error(`TLS profile unavailable: ${TLS_PROFILE}`)
    client = createClient({
      browser: TLS_PROFILE,
      disableDefaultHeaders: true,
      compress: false,
      redirect: "manual",
      retry: 0,
      proxy: false,
    })
  }
  return client
}

export async function verifyTlsTransport(): Promise<void> {
  await getClient()
}

type TransportOptions = RequestInit & {
  timeoutMs?: number
  proxy?: string
  decompress?: boolean
  tls?: { ca?: string | string[]; rejectUnauthorized?: boolean }
}

export async function tlsFetch(url: string, init: TransportOptions = {}): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 60_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("TLS request timed out")
  if (init.body != null && typeof init.body !== "string")
    throw new Error("TLS transport requires a string request body")
  if (init.signal?.aborted) throw new DOMException("TLS request aborted", "AbortError")
  const deadline = Date.now() + timeoutMs
  const nativeAbort = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let output: ReadableStreamDefaultController<Uint8Array> | undefined
  let failure: Error | undefined
  let rejectStopped: (error: Error) => void = () => {}
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject
  })
  void stopped.catch(() => {})
  const finish = () => {
    clearTimeout(timer)
    init.signal?.removeEventListener("abort", abort)
  }
  const stop = (error: Error) => {
    if (failure) return
    failure = error
    finish()
    rejectStopped(error)
    nativeAbort.abort(error)
    output?.error(error)
    void reader?.cancel(error).catch(() => {})
  }
  const abort = () => stop(new DOMException("TLS request aborted", "AbortError"))
  const timer = setTimeout(() => stop(new Error("TLS request timed out")), timeoutMs)
  init.signal?.addEventListener("abort", abort, { once: true })
  try {
    const nativeClient = await getClient()
    if (failure) throw failure
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("TLS request timed out")
    const headers =
      init.headers instanceof Headers
        ? [...init.headers.entries()]
        : Array.isArray(init.headers)
          ? init.headers
          : Object.entries(init.headers ?? {})
    const ca = init.tls?.ca
    const pending = nativeClient.fetch(url, {
      proxy: init.proxy ?? false,
      method: init.method,
      body: init.body,
      headers,
      signal: nativeAbort.signal,
      timeout: remaining,
      ...(ca ? { ca: { cert: ca, includeDefaultRoots: true } } : {}),
      ...(init.tls?.rejectUnauthorized === false
        ? { tlsDanger: { certVerification: false, verifyHostname: false } }
        : {}),
    })
    void pending.then(
      (response) => {
        if (failure) void response.body?.cancel(failure).catch(() => {})
      },
      () => {},
    )
    const native = await Promise.race([pending, stopped])
    reader = native.body?.getReader()
    if (failure) {
      await reader?.cancel(failure)
      throw failure
    }
    const responseHeaders = new Headers()
    native.headers.forEach((value, name) => {
      if (name.toLowerCase() !== "set-cookie") responseHeaders.append(name, value)
    })
    for (const cookie of native.headers.getSetCookie()) responseHeaders.append("set-cookie", cookie)
    const noBody = init.method?.toUpperCase() === "HEAD" || [204, 205, 304].includes(native.status)
    let stream: ReadableStream<Uint8Array> | null = null
    if (reader && !noBody) {
      const bodyReader = reader
      stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            output = controller
          },
          async pull(controller) {
            try {
              const chunk = await bodyReader.read()
              if (failure) return
              if (chunk.done) {
                finish()
                controller.close()
              } else controller.enqueue(chunk.value)
            } catch (error) {
              finish()
              if (!failure) controller.error(error)
              await bodyReader.cancel(error).catch(() => {})
            }
          },
          async cancel(reason) {
            finish()
            await bodyReader.cancel(reason)
          },
        },
        { highWaterMark: 0 },
      )
    } else {
      finish()
      await reader?.cancel()
    }
    const response = new Response(stream, { status: native.status, headers: responseHeaders })
    Object.defineProperty(response, "url", { value: native.url || url })
    return response
  } catch (error) {
    finish()
    await reader?.cancel(error).catch(() => {})
    throw failure ?? error
  }
}

export const tier1Transport = { fetch: tlsFetch }
