import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Elysia } from "elysia"
import { MITM_PROXY_CA_DIR, MITM_PROXY_ENABLED } from "../config"

// Serves the MITM proxy CA certificate for easy installation into a client's trust
// store (e.g. `curl http://trawl:8191/proxy-ca.crt`). Only mounted when proxy mode is on.
export function proxyCaRoute() {
  const app = new Elysia()
  if (!MITM_PROXY_ENABLED) return app

  return app.get("/proxy-ca.crt", ({ set }) => {
    const path = join(MITM_PROXY_CA_DIR, "ca.crt")
    if (!existsSync(path)) {
      set.status = 503
      return "CA not generated yet — start the proxy first"
    }
    set.headers["content-type"] = "application/x-pem-file"
    set.headers["content-disposition"] = 'attachment; filename="trawl-proxy-ca.crt"'
    return readFileSync(path, "utf8")
  })
}
