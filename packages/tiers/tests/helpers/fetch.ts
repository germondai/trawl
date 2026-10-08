export function installFetchMock(responder: (...args: Parameters<typeof fetch>) => Response | Promise<Response>) {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => responder(...args), {
    preconnect: original.preconnect,
  })
  return () => {
    globalThis.fetch = original
  }
}

export async function withFetch(response: Response, run: () => Promise<void>) {
  const restore = installFetchMock(() => response)
  try {
    await run()
  } finally {
    restore()
  }
}
