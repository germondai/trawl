import { expect, test } from "bun:test"
import { computed, effectScope, nextTick, reactive, shallowRef, watch } from "vue"
import { useCaptureArtifact } from "../app/composables/useCaptureArtifact"
import { useSavedCaptures } from "../app/composables/useSavedCaptures"
import { validateJpegPreview } from "../app/utils/jpeg-preview"

test("capture viewing isolates instances, validates bytes and releases waits on hide or disposal", async () => {
  const visible = shallowRef("visible")
  const signals: AbortSignal[] = []
  let finish: ((value: Uint8Array) => void) | undefined
  const content = new TextEncoder().encode("owned content")
  const digest = await crypto.subtle.digest("SHA-256", content)
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  const artifact = { kind: "html" as const, state: "ready" as const, bytes: content.byteLength, sha256: hash }
  const reference = { id: "owned", at: "2026-11-16T10:00:00.000Z" }
  const desktop = reactive({
    native: true,
    activeId: "first",
    active: { baseURL: "https://owned.fixture" },
    capabilities: { captures: true },
    client: () => ({
      requests: {
        captures: async (_id: string, options: { signal: AbortSignal }) => {
          signals.push(options.signal)
          return { requestId: reference.id, requestAt: reference.at, mode: "html", artifacts: [artifact] }
        },
        artifact: async (_id: string, _kind: string, options: { signal: AbortSignal }) => {
          signals.push(options.signal)
          return new Promise<Uint8Array>((resolve) => {
            finish = resolve
          })
        },
      },
    }),
  })
  const globals = { computed, shallowRef, watch, useDesktopStore: () => desktop, useDocumentVisibility: () => visible }
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Reflect.set(globalThis, key, value)
  const scope = effectScope()
  try {
    const state = scope.run(() => ({
      metadata: useSavedCaptures(() => reference),
      file: useCaptureArtifact(
        () => reference,
        () => artifact,
      ),
    }))
    if (!state) throw new Error("Missing scope")
    await nextTick()
    expect(state.metadata.manifest.value?.requestId).toBe(reference.id)
    const previousWait = finish
    desktop.activeId = "second"
    expect(state.metadata.manifest.value).toBeUndefined()
    await nextTick()
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(true)
    previousWait?.(content)
    await Bun.sleep(0)
    expect(state.file.bytes.value).toBeUndefined()
    finish?.(new TextEncoder().encode("changed"))
    await Bun.sleep(0)
    expect(state.file.error.value).toContain("Saved content changed")
    state.file.retry()
    await nextTick()
    finish?.(content)
    await Bun.sleep(0)
    expect(state.file.bytes.value).toEqual(content)
    visible.value = "hidden"
    expect(state.file.bytes.value).toBeUndefined()
    await nextTick()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(state.metadata.manifest.value).toBeUndefined()
    scope.stop()
  } finally {
    scope.stop()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test("binary screenshot previews reject excessive pixels and unbounded marker scans", () => {
  const jpeg = (width: number, height: number) =>
    new Uint8Array([255, 216, 255, 192, 0, 8, 8, height >> 8, height & 255, width >> 8, width & 255, 0])
  expect(() => validateJpegPreview(jpeg(640, 480))).not.toThrow()
  expect(() => validateJpegPreview(jpeg(16000, 16000))).toThrow("megapixel")
  const markers = new Uint8Array(100000).fill(255)
  markers[1] = 216
  expect(() => validateJpegPreview(markers)).toThrow("dimensions")
})
