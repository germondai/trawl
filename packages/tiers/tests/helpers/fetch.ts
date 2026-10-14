import { tier1Transport } from "../../src/utils/tlsTransport"

export function installFetchMock(
  responder: (...args: Parameters<typeof tier1Transport.fetch>) => Response | Promise<Response>,
) {
  const original = tier1Transport.fetch
  tier1Transport.fetch = async (...args) => responder(...args)
  return () => {
    tier1Transport.fetch = original
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
