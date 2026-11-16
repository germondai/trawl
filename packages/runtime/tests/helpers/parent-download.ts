// An owned slow transfer exercises parent death without contacting an external service.
const slow = async (_input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) =>
  new Response(
    new ReadableStream({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 2]))
        options?.signal?.addEventListener("abort", () => stream.error(new Error("Parent cancelled download")), {
          once: true,
        })
        process.stderr.write("download started\n")
      },
    }),
  )
globalThis.fetch = Object.assign(slow, { preconnect: () => {} })
await import("../../src/server")

export {}
