import { expect, test } from "bun:test"
import type { Page } from "patchright"
import {
  type CaptchaProfile,
  parseCaptchaProfiles,
  prepareCaptchaProfile,
  solutionValue,
} from "../src/solvers/captchaProfiles"
import { ExternalCaptchaSession } from "../src/solvers/externalCaptcha"

const profile: CaptchaProfile = {
  hostname: "example.com",
  selector: "#widget",
  taskType: "GeeTestTaskProxyless",
  inputs: {
    gt: { selector: "#widget", attribute: "data-gt" },
    challenge: { selector: "#widget", attribute: "data-challenge" },
  },
  delivery: {
    fields: [
      { selector: "#challenge", path: ["challenge"] },
      { selector: "#validate", path: ["validate"] },
      { selector: "#seccode", path: ["seccode"] },
    ],
    verifySelector: "#accepted",
  },
}

test("profiles require a precise hostname, valid task fields and a verification target", () => {
  expect(parseCaptchaProfiles([profile])).toEqual([profile])
  for (const patch of [
    { hostname: "*.example.com" },
    { taskType: "unknown" },
    { inputs: { clientKey: { value: "secret" } } },
    { delivery: { callback: "__proto__.accept", verifySelector: "#accepted" } },
    { delivery: { callback: "accept" } },
    { inputs: { gt: { source: "global", path: ["constructor"] } } },
  ])
    expect(() => parseCaptchaProfiles([{ ...profile, ...patch }])).toThrow()
  expect(() => parseCaptchaProfiles([{ ...profile, inputs: { gt: { source: "cookies" } } }])).toThrow(
    "allowSessionData",
  )
  expect(() => parseCaptchaProfiles([{ ...profile, inputs: { gt: { source: "html" } } }])).toThrow("allowSessionData")
})

test("solution paths use own properties and support complete structured or scalar responses", () => {
  expect(solutionValue({ nested: { value: "owned" } }, ["nested", "value"])).toBe("owned")
  expect(solutionValue("owned", [])).toBe("owned")
  expect(solutionValue({ coords: [{ x: 5, y: 8 }] }, ["coords", "0", "x"])).toBe(5)
  expect(solutionValue(Object.create({ token: "inherited" }), ["token"])).toBeUndefined()
  expect(solutionValue({}, ["constructor"])).toBeUndefined()
})

function page(values: Record<string, unknown>, host = "example.com") {
  return {
    url: () => `https://${host}/fixture`,
    evaluate: async (_fn: unknown, arg: unknown) => (arg ? values : "owned-UA"),
  } as unknown as Page
}

test("task preparation enforces hostname, dynamic parameters and browser proxy mode", async () => {
  expect(await prepareCaptchaProfile(page({ gt: "owned-gt", challenge: "owned-challenge" }), profile, {})).toEqual({
    type: "GeeTestTaskProxyless",
    websiteURL: "https://example.com/fixture",
    userAgent: "owned-UA",
    gt: "owned-gt",
    challenge: "owned-challenge",
  })
  expect(await prepareCaptchaProfile(page({ gt: "owned-gt" }), profile, {})).toBeNull()
  expect(
    await prepareCaptchaProfile(
      page({ gt: "owned-gt", challenge: "owned-challenge" }, "other.example.com"),
      profile,
      {},
    ),
  ).toBeNull()
  expect(
    await prepareCaptchaProfile(page({ gt: "owned-gt", challenge: "owned-challenge" }), profile, {
      proxyType: "http",
      proxyAddress: "proxy.example.com",
      proxyPort: 8080,
    }),
  ).toBeNull()
})

test("a changed challenge cannot receive a result for an old task", async () => {
  let challenge = "owned-original"
  const fixture = page({})
  fixture.evaluate = (async (_fn: unknown, arg: unknown) =>
    arg ? { gt: "owned-gt", challenge } : "owned-UA") as Page["evaluate"]
  const calls: string[] = []
  const fetcher = (async (url: unknown) => {
    calls.push(String(url))
    return Response.json(
      String(url).endsWith("createTask")
        ? { errorId: 0, taskId: 42 }
        : { errorId: 0, status: "ready", solution: { challenge: "solved", validate: "solved", seccode: "solved" } },
    )
  }) as unknown as typeof fetch
  const session = new ExternalCaptchaSession(
    { apiKey: "owned-key", maxTasks: 1, timeoutMs: 12000, localTimeoutMs: 100, profiles: [profile] },
    fetcher,
    async () => {
      challenge = "owned-new"
    },
  )
  expect(await session.solve(fixture, "profile:0", 12000)).toBe(false)
  expect(calls).toHaveLength(2)
  expect(session.supports("profile:0")).toBe(false)
})

test("invalid cookies and out-of-bounds clicks never mutate the browser", async () => {
  const { deliverCaptchaProfile } = await import("../src/solvers/captchaProfiles")
  let mutations = 0
  const fixture = {
    url: () => "https://example.com/fixture",
    evaluate: async () => {
      mutations++
      return true
    },
    locator: () => ({ count: async () => 1, boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 }) }),
  } as unknown as Page
  const cookieProfile: CaptchaProfile = {
    ...profile,
    delivery: { cookies: [{ name: "owned", path: ["cookie"], format: "set-cookie" }], verifySelector: "#accepted" },
  }
  expect(
    await deliverCaptchaProfile(
      fixture,
      cookieProfile,
      { cookie: "other=value; Domain=example.com" },
      new AbortController().signal,
    ),
  ).toBe(false)
  expect(
    await deliverCaptchaProfile(
      fixture,
      cookieProfile,
      { cookie: "owned=value\r\nInjected: yes" },
      new AbortController().signal,
    ),
  ).toBe(false)
  const gridProfile: CaptchaProfile = {
    ...profile,
    delivery: {
      clicks: { selector: "#grid", path: ["click"], mode: "grid", rows: 2, columns: 2 },
      verifySelector: "#accepted",
    },
  }
  for (const click of [[0], [5], [1.5], [1, 5]])
    expect(await deliverCaptchaProfile(fixture, gridProfile, { click }, new AbortController().signal)).toBe(false)
  expect(mutations).toBe(0)
})
