import { expect, test } from "bun:test"
import { parseRequestFields, serializeRequestFields } from "../app/utils/request-fields"
import { newWorkbenchDraft, replacesWorkbenchDraft, workbenchRequest } from "../app/utils/workbench"

test("field tables preserve repeated query values and keep disabled rows/descriptions off the wire", () => {
  const rows = parseRequestFields("q=the+lord+of+the+rings\nq=second&empty=", "query")
  rows[0]!.description = "Search title"
  rows[1]!.enabled = false
  expect(serializeRequestFields(rows, "query")).toBe("q=the+lord+of+the+rings&empty=")
  expect(parseRequestFields("q=one&q=two", "query").map((row) => row.value)).toEqual(["one", "two"])
  expect(serializeRequestFields(parseRequestFields('{"X-Test":"value"}', "headers"), "headers")).toBe(
    '{\n  "X-Test": "value"\n}',
  )
  expect(() => serializeRequestFields(parseRequestFields('{"X-Test":"1","x-test":"2"}', "headers"), "headers")).toThrow(
    "unique",
  )
  expect(() =>
    serializeRequestFields([{ enabled: true, key: "X-Test", value: "a\r\nb", description: "" }], "headers"),
  ).toThrow("single-line")
  expect(() => parseRequestFields('{"X-Test":1}', "headers")).toThrow("string")
})

test("URL-encoded, multipart text fields and GraphQL produce the expected native payloads", async () => {
  const draft = {
    ...newWorkbenchDraft(),
    url: "https://owned.fixture/",
    method: "POST" as const,
    body: "tag=first\ntag=second&unicode=%C4%8D",
  }
  expect(workbenchRequest({ ...draft, bodyMode: "urlencoded" })).toMatchObject({
    body: "tag=first&tag=second&unicode=%C4%8D",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  })
  const multipart = workbenchRequest({ ...draft, bodyMode: "form", headers: '{"Content-Type":"wrong"}' })
  const request = new Request(draft.url, { method: "POST", headers: multipart.headers, body: multipart.body as string })
  const form = await request.formData()
  expect(form.getAll("tag")).toEqual(["first", "second"])
  expect(form.get("unicode")).toBe("č")
  expect(multipart.headers?.["Content-Type"]).toMatch(/^multipart\/form-data; boundary=trawl-/)
  expect(
    workbenchRequest({
      ...draft,
      bodyMode: "graphql",
      body: "query($id: ID!) { item(id:$id) { id } }",
      graphqlVariables: '{"id":"7"}',
    }).body,
  ).toEqual({ query: "query($id: ID!) { item(id:$id) { id } }", variables: { id: "7" } })
  expect(() => workbenchRequest({ ...draft, bodyMode: "graphql", graphqlVariables: "[]" })).toThrow("JSON object")
  expect(() => workbenchRequest({ ...draft, method: "GET", bodyMode: "form" })).toThrow("body-capable")
  expect(
    workbenchRequest({ ...draft, bodyMode: "text", bodyContentType: "application/xml", body: "<item/>" }),
  ).toMatchObject({ body: "<item/>", headers: { "Content-Type": "application/xml" } })
})

test("equivalent structured drafts are not treated as unsaved replacements", () => {
  const empty = newWorkbenchDraft()
  expect(replacesWorkbenchDraft(empty, newWorkbenchDraft())).toBe(false)
  const draft = { ...empty, url: "https://owned.fixture/" }
  expect(replacesWorkbenchDraft(draft, structuredClone(draft))).toBe(false)
  expect(replacesWorkbenchDraft(draft, newWorkbenchDraft())).toBe(true)
  expect(
    workbenchRequest({
      ...draft,
      fields: {
        ...draft.fields,
        headers: [{ enabled: true, key: "X-UI", value: "ignored", description: "only editor metadata" }],
      },
    }).headers,
  ).toEqual({})
})
test("bulk input cannot create an unbounded field table", () => {
  const text = Array.from({ length: 101 }, (_, index) => `key${index}=value`).join("&")
  expect(() => parseRequestFields(text, "query")).toThrow("100 field rows")
  expect(parseRequestFields(text.split("&").slice(0, 100).join("&"), "query")).toHaveLength(100)
})

test("file bodies and multipart files preserve bytes without putting descriptions or disabled rows on the wire", async () => {
  const { base64Bytes, bytesBase64, readRequestFile } = await import("../app/utils/request-body")
  const bytes = new Uint8Array([0, 255, 128, 13, 10, 1])
  const file = await readRequestFile(new File([bytes], "owned.bin", { type: "application/octet-stream" }))
  const draft = {
    ...newWorkbenchDraft(),
    url: "https://owned.fixture/",
    method: "POST" as const,
    bodyMode: "binary" as const,
    body: file.data,
    binaryName: file.name,
  }
  expect(base64Bytes(workbenchRequest(draft).body as string)).toEqual(bytes)
  expect(workbenchRequest(draft).bodyEncoding).toBe("base64")
  const rows = [
    { enabled: true, key: "upload", value: "", description: "editor metadata", file },
    { enabled: false, key: "skip", value: "", description: "", file },
  ]
  const request = workbenchRequest({
    ...draft,
    bodyMode: "form",
    body: "tag=first&tag=second&unicode=%C4%8D",
    fields: { ...draft.fields, body: rows },
  })
  const form = await new Request(draft.url, {
    method: "POST",
    headers: request.headers,
    body: Uint8Array.from(atob(request.body as string), (c) => c.charCodeAt(0)),
  }).formData()
  expect(form.getAll("tag")).toEqual(["first", "second"])
  expect(form.get("unicode")).toBe("č")
  expect(form.has("skip")).toBe(false)
  expect(form.get("upload")).toBeInstanceOf(File)
  expect(new Uint8Array(await (form.get("upload") as File).arrayBuffer())).toEqual(bytes)
  expect(serializeRequestFields(rows, "query")).toBe("")
  expect(bytesBase64(base64Bytes(file.data))).toBe(file.data)
  await expect(readRequestFile(new File([new Uint8Array(128 * 1024 + 1)], "large.bin"))).rejects.toThrow("128 KiB")
  expect(() => base64Bytes("Zh==")).toThrow("Invalid")
  expect(() => workbenchRequest({ ...draft, binaryName: "" })).toThrow("Choose")
})

test("target Auth stays separate from instance authentication and requires server capability support", async () => {
  const { requireWorkbenchCapabilities } = await import("../app/utils/workbench")
  const { Trawl } = await import("@trawl/client")
  const draft = {
    ...newWorkbenchDraft(),
    url: "https://target.fixture/",
    auth: { ...newWorkbenchDraft().auth, type: "bearer" as const, token: "owned-target" },
  }
  const request = workbenchRequest(draft)
  expect(request).toMatchObject({ maxTier: 1, targetAuth: { type: "bearer", token: "owned-target" } })
  expect(request.headers).toEqual({})
  expect(
    workbenchRequest({ ...draft, auth: { ...draft.auth, type: "basic", username: "user", password: "p" } }).targetAuth,
  ).toEqual({ type: "basic", username: "user", password: "p" })
  expect(
    workbenchRequest({ ...draft, auth: { ...draft.auth, type: "api-key", name: "key", value: "value", in: "query" } })
      .targetAuth,
  ).toEqual({ type: "api-key", name: "key", value: "value", in: "query" })
  for (const override of [
    { sessionId: "session" },
    { output: "screenshot" as const },
    { options: '{"skipHttp":true}' },
  ])
    expect(() => workbenchRequest({ ...draft, ...override })).toThrow("HTTP only")
  expect(() => requireWorkbenchCapabilities(draft)).toThrow("running instance")
  expect(() => requireWorkbenchCapabilities(draft, {} as never)).toThrow("Update")
  const capabilities = { requestOptions: { binaryBodies: true, targetAuth: true } } as never
  expect(() => requireWorkbenchCapabilities(draft, capabilities)).not.toThrow()
  expect(() => requireWorkbenchCapabilities(newWorkbenchDraft(), {} as never)).not.toThrow()
  let sent: Request | undefined
  const api = new Trawl({
    baseURL: "https://instance.fixture",
    apiKey: "owned-instance",
    fetch: async (input, init) => {
      sent = new Request(input, init)
      return Response.json({
        url: draft.url,
        html: "Owned response",
        cookies: [],
        userAgent: "fixture",
        statusCode: 200,
        tier: 1,
        sessionCached: false,
        timings: [],
        totalMs: 1,
      })
    },
  })
  const { sendWorkbench } = await import("../app/utils/workbench")
  await sendWorkbench(api, draft, new AbortController().signal)
  expect(sent?.headers.get("Authorization")).toBe("Bearer owned-instance")
  expect(await sent?.json()).toMatchObject({ targetAuth: { token: "owned-target" }, maxTier: 1 })
})
