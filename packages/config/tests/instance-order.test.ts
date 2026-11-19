import { expect, test } from "bun:test"
import { emptyConfig, orderedInstanceIds } from "../src/catalog"

test("instance order includes local, ignores stale IDs and appends missing profiles", () => {
  const desktop = emptyConfig().desktop
  desktop.connections = [
    { id: "home", name: "Home", baseURL: "https://example.com" },
    { id: "lab", name: "Lab", baseURL: "https://example.com" },
  ]
  expect(orderedInstanceIds(desktop)).toEqual(["local", "home", "lab"])
  desktop.instanceOrder = ["home", "gone", "home", "local"]
  expect(orderedInstanceIds(desktop)).toEqual(["home", "local", "lab"])
})
