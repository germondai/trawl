import { describe, expect, test } from "bun:test"
import { EventJournal } from "./eventJournal"

const text = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const value = await reader.read()
  return value.done ? "" : new TextDecoder().decode(value.value)
}
const limits = { entries: 3, bytes: 1024, entryBytes: 512, clients: 2, queueBytes: 1, heartbeatMs: 100 }

describe("bounded event journal", () => {
  test("an oversized publication advances the cursor and explicitly resets connected readers", async () => {
    const journal = new EventJournal<string>(limits)
    const before = journal.cursor
    const reader = journal
      .stream(new Request("http://localhost/events", { headers: { "Last-Event-ID": before } }))
      .body?.getReader()
    if (!reader) throw new Error("Missing stream")
    await text(reader)
    expect(journal.publish("x".repeat(1024))).toBe(false)
    expect(journal.cursor).not.toBe(before)
    expect(await text(reader)).toContain("event: reset")
    journal.publish("recovered")
    expect(await text(reader)).toContain('data: "recovered"')
    await reader.cancel()
    journal.close()
  })
  test("replays from the snapshot cursor without duplicating its entries", async () => {
    const journal = new EventJournal<{ value: number }>(limits)
    journal.publish({ value: 1 })
    const snapshot = journal.snapshot()
    journal.publish({ value: 2 })
    const reader = journal
      .stream(
        new Request("http://localhost/events", {
          headers: { "Last-Event-ID": snapshot.cursor },
        }),
      )
      .body?.getReader()
    if (!reader) throw new Error("Missing stream response")
    expect(await text(reader)).toContain("event: ready")
    const update = await text(reader)
    expect(update).toContain('data: {"value":2}')
    expect(update).not.toContain('"value":1')
    expect(update).toContain(`id: ${journal.cursor}`)
    expect(journal.subscribers).toBe(1)
    await reader.cancel()
    expect(journal.subscribers).toBe(0)
    journal.close()
  })

  test("signals an expired replay to a slow reader and resumes with new entries", async () => {
    const journal = new EventJournal<number>(limits)
    const cursor = journal.cursor
    const reader = journal
      .stream(
        new Request("http://localhost/events", {
          headers: { "Last-Event-ID": cursor },
        }),
      )
      .body?.getReader()
    if (!reader) throw new Error("Missing stream response")
    for (let value = 0; value < 10; value++) journal.publish(value)
    expect(await text(reader)).toContain("event: ready")
    expect(await text(reader)).toContain('"reason":"replay-expired"')
    journal.publish(42)
    expect(await text(reader)).toContain("data: 42")
    expect(journal.snapshot().entries.map(({ data }) => data)).toEqual([8, 9, 42])
    await reader.cancel()
    journal.close()
  })

  test("detects server restarts, invalid/future cursors and initial connections", async () => {
    const old = new EventJournal<number>(limits)
    const journal = new EventJournal<number>(limits)
    for (const cursor of [undefined, old.cursor, "invalid", `${journal.cursor.split(":")[0]}:999`]) {
      const reader = journal
        .stream(
          new Request("http://localhost/events", {
            headers: cursor ? { "Last-Event-ID": cursor } : {},
          }),
        )
        .body?.getReader()
      if (!reader) throw new Error("Missing stream response")
      expect(await text(reader)).toContain("event: reset")
      await reader.cancel()
    }
    old.close()
    journal.close()
  })

  test("bounds entries, retained bytes, clients and releases pending pulls on abort", async () => {
    const journal = new EventJournal<string>({ ...limits, bytes: 400, clients: 1 })
    expect(journal.publish("x".repeat(1024))).toBe(false)
    for (let index = 0; index < 100; index++) journal.publish("x".repeat(100))
    expect(journal.snapshot().entries.length).toBeLessThanOrEqual(1)
    const abort = new AbortController()
    const reader = journal.stream(new Request("http://localhost/events", { signal: abort.signal })).body?.getReader()
    if (!reader) throw new Error("Missing stream response")
    expect(journal.stream(new Request("http://localhost/events")).status).toBe(429)
    await text(reader)
    const waiting = reader.read()
    abort.abort()
    expect((await waiting).done).toBe(true)
    expect(journal.subscribers).toBe(0)
    journal.close()
    expect(journal.stream(new Request("http://localhost/events")).status).toBe(503)
  })

  test("publishes heartbeats without advancing the replay cursor", async () => {
    const journal = new EventJournal<number>({ ...limits, heartbeatMs: 5 })
    const cursor = journal.cursor
    const reader = journal.stream(new Request("http://localhost/events")).body?.getReader()
    if (!reader) throw new Error("Missing stream response")
    await text(reader)
    expect(await text(reader)).toContain(": heartbeat")
    expect(journal.cursor).toBe(cursor)
    journal.close()
    expect(journal.subscribers).toBe(0)
  })
})
