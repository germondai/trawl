import { expect, test } from "bun:test"
import { connectionChanges } from "../app/utils/connections"

test("editing a connection preserves its ID and redacted token unless replaced or explicitly removed", () => {
  const previous = { id: "owned", name: "Before", baseURL: "https://owned.invalid", apiKey: "[redacted]" }
  const draft = { name: " After ", baseURL: " https://changed.invalid ", apiKey: "", removeKey: false }
  expect(connectionChanges(previous, draft)).toEqual({ ...previous, name: "After", baseURL: "https://changed.invalid" })
  expect(connectionChanges(previous, { ...draft, apiKey: "owned-fixture-token" }).apiKey).toBe("owned-fixture-token")
  expect(connectionChanges(previous, { ...draft, removeKey: true })).not.toHaveProperty("apiKey")
  expect(previous.name).toBe("Before")
})
