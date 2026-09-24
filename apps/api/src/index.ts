import { createApiApp } from "./app"
import {
  HEADFUL_POOL_SIZE,
  MITM_ALWAYS_SCRAPE,
  MITM_CA_DIR,
  MITM_DEBUG,
  MITM_ENABLED,
  MITM_HOST,
  MITM_MAX_TIER,
  MITM_PORT,
  POOL_SIZE,
  PORT,
  SCRAPE_MIN_TIER,
  SCRAPE_PROXY_SELECTION,
} from "./config"
import { getDeps, initPool } from "./deps"
import { registerLifecycleHandlers } from "./lifecycle"
import { type MitmProxyHandle, shutdownMitmProxy, startMitmProxy } from "./proxy/server"
import { startMemoryMonitor } from "./runtimeMemory"

createApiApp().listen(PORT)

console.log(`[api] TRAWL starting on :${PORT}  (pool: ${POOL_SIZE} browser${POOL_SIZE === 1 ? "" : "s"})`)
if (SCRAPE_MIN_TIER > 1) console.log(`[api] scraper tier floor: ${SCRAPE_MIN_TIER}`)
if (SCRAPE_PROXY_SELECTION !== "failover") console.log(`[api] proxy selection: ${SCRAPE_PROXY_SELECTION}`)

const state: { proxyHandle?: MitmProxyHandle } = {}
const stopMemoryMonitor = startMemoryMonitor(POOL_SIZE, HEADFUL_POOL_SIZE)

const poolReady = initPool()

// Tier 0 does not need a browser, and browser-backed requests already have a
// bounded acquire queue. Start accepting proxy traffic while the pool warms.
if (MITM_ENABLED) {
  state.proxyHandle = startMitmProxy({
    port: MITM_PORT,
    host: MITM_HOST,
    caDir: MITM_CA_DIR,
    deps: getDeps(),
    maxTier: MITM_MAX_TIER,
    alwaysScrape: MITM_ALWAYS_SCRAPE,
    debug: MITM_DEBUG,
  })
}

poolReady.catch((err) => {
  console.error("[api] startup failed:", err)
  process.exit(1)
})

registerLifecycleHandlers({
  onShutdown: async () => {
    stopMemoryMonitor()
    if (state.proxyHandle) await shutdownMitmProxy(state.proxyHandle)
  },
})
