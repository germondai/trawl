import { expect, test } from "bun:test"
import { createApiApp } from "./app"
import { allowLocalRequest } from "./localAccess"

test("managed instances allow native clients and their same-origin dashboard", () => {
  expect(
    allowLocalRequest(new Request("http://127.0.0.1:8191/", { headers: { host: "127.0.0.1:8191" } }), "127.0.0.1"),
  ).toBe(true)
  expect(
    allowLocalRequest(
      new Request("http://localhost:8191/dashboard/metrics", {
        headers: { host: "localhost:8191", origin: "http://localhost:8191" },
      }),
      "127.0.0.1",
    ),
  ).toBe(true)
})
test.each(["host.docker.internal", "host.orb.internal"])("allows container clients through %s", (hostname) => {
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    const url = `http://${hostname}:8191/`
    expect(allowLocalRequest(new Request(url, { headers: { host: `${hostname}:8191` } }), host)).toBe(true)
    expect(
      allowLocalRequest(new Request(url, { headers: { host: `${hostname}:8191`, origin: new URL(url).origin } }), host),
    ).toBe(true)
    const crossOrigin: HeadersInit[] = [{ origin: "https://other.example" }, { "sec-fetch-site": "cross-site" }]
    for (const headers of crossOrigin) expect(allowLocalRequest(new Request(url, { headers }), host)).toBe(false)
  }
})
test("container aliases do not allow unrelated hostnames or embedded credentials", () => {
  for (const host of [
    "host.docker.internal.other.example:8191",
    "other.host.docker.internal:8191",
    "host.orb.internal.other.example:8191",
    "other.host.orb.internal:8191",
    "user:password@host.docker.internal:8191",
    "host.docker.internal@other.example:8191",
  ])
    expect(allowLocalRequest(new Request("http://127.0.0.1:8191/", { headers: { host } }), "127.0.0.1")).toBe(false)
})
test("rejects cross-origin browser calls and rebound hostnames", () => {
  const variants: HeadersInit[] = [
    { host: "127.0.0.1:8191", origin: "https://other.example" },
    { host: "other.example:8191" },
    { host: "127.0.0.1:8191", "sec-fetch-site": "cross-site" },
  ]
  for (const headers of variants)
    expect(allowLocalRequest(new Request("http://127.0.0.1:8191/", { headers }), "127.0.0.1")).toBe(false)
})
test("the real API pipeline applies the guard only when managed", async () => {
  const denied = new Request("http://127.0.0.1:8191/", {
    headers: { host: "127.0.0.1:8191", origin: "https://other.example" },
  })
  expect((await createApiApp({ localManaged: true }).handle(denied)).status).toBe(403)
  expect((await createApiApp({ localManaged: false }).handle(new Request(denied))).status).toBe(200)
})
test.each(["host.docker.internal", "host.orb.internal"])("the managed API accepts %s", async (hostname) => {
  const app = createApiApp({ localManaged: true })
  const url = `http://${hostname}:8191/`
  expect((await app.handle(new Request(url))).status).toBe(200)
  expect((await app.handle(new Request(url, { headers: { origin: "https://other.example" } }))).status).toBe(403)
  expect((await app.handle(new Request(url, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403)
})
