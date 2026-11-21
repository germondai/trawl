<script setup lang="ts">
import { t } from "~/utils/localization"

const props = defineProps<{ root: HTMLElement | null }>()
const open = defineModel<boolean>({ default: false })
const query = shallowRef("")
const matches = shallowRef<Range[]>([])
const index = shallowRef(0)
const input = useTemplateRef("input")
let timer: ReturnType<typeof setTimeout> | undefined
const marks = shallowRef<{ x: number; y: number; width: number; height: number; active: boolean }[]>([])
let frame = 0
function focus() {
  input.value?.inputRef?.focus()
  input.value?.inputRef?.select()
}
defineExpose({ focus })
function paint() {
  const root = props.root
  const bounds = root?.parentElement?.getBoundingClientRect()
  if (!open.value || !root || !bounds) {
    marks.value = []
    return
  }
  const viewport = root.getBoundingClientRect()
  marks.value = matches.value.flatMap((range, match) => {
    const clip = {
      left: Math.max(bounds.left, viewport.left),
      right: Math.min(bounds.right, viewport.right),
      top: Math.max(bounds.top, viewport.top),
      bottom: Math.min(bounds.bottom, viewport.bottom),
    }
    for (let node = range.startContainer.parentElement; node && node !== root; node = node.parentElement) {
      const style = getComputedStyle(node),
        box = node.getBoundingClientRect()
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, box.left + node.clientLeft)
        clip.right = Math.min(clip.right, box.left + node.clientLeft + node.clientWidth)
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, box.top + node.clientTop)
        clip.bottom = Math.min(clip.bottom, box.top + node.clientTop + node.clientHeight)
      }
    }
    return [...range.getClientRects()].flatMap((rect) => {
      const left = Math.max(rect.left, clip.left),
        right = Math.min(rect.right, clip.right),
        top = Math.max(rect.top, clip.top),
        bottom = Math.min(rect.bottom, clip.bottom)
      return right > left && bottom > top
        ? [
            {
              x: left - bounds.left,
              y: top - bounds.top,
              width: right - left,
              height: bottom - top,
              active: match === index.value,
            },
          ]
        : []
    })
  })
}
function schedulePaint() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(paint)
}
function reveal() {
  const range = matches.value[index.value],
    root = props.root
  if (range && root) {
    for (let node = range.startContainer.parentElement; node; node = node.parentElement) {
      const rect = range.getBoundingClientRect(),
        box = node.getBoundingClientRect(),
        style = getComputedStyle(node)
      const inset = node === root ? Number.parseFloat(style.scrollPaddingTop) || 0 : 0
      const top =
        /auto|scroll/.test(style.overflowY) && (rect.top < box.top + inset || rect.bottom > box.bottom)
          ? rect.top - box.top - inset - (node.clientHeight - inset - rect.height) / 2
          : 0
      const left =
        /auto|scroll/.test(style.overflowX) && (rect.left < box.left || rect.right > box.right)
          ? rect.left - box.left - (node.clientWidth - rect.width) / 2
          : 0
      if (top || left)
        node.scrollBy({
          top,
          left,
          behavior: node === root && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant",
        })
      if (node === root) break
    }
  }
  paint()
}
function search() {
  const found: Range[] = []
  const needle = query.value
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
  if (open.value && needle && props.root) {
    const walker = document.createTreeWalker(props.root, NodeFilter.SHOW_TEXT)
    while (found.length < 500) {
      const node = walker.nextNode()
      if (!node) break
      const parent = node.parentElement
      if (
        !parent ||
        parent.closest('script,style,textarea,[aria-hidden="true"]') ||
        !parent.getClientRects().length ||
        getComputedStyle(parent).visibility === "hidden"
      )
        continue
      for (const match of (node.textContent ?? "").matchAll(pattern)) {
        if (found.length >= 500) break
        const start = match.index
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, start + match[0].length)
        found.push(range)
      }
    }
  }
  matches.value = found
  index.value = Math.min(index.value, Math.max(0, found.length - 1))
  paint()
}
function next(direction: number) {
  if (!matches.value.length) return
  index.value = (index.value + direction + matches.value.length) % matches.value.length
  reveal()
}
watch(query, () => {
  index.value = 0
  search()
  reveal()
})
watch(open, async (value) => {
  if (value) {
    await nextTick()
    input.value?.inputRef?.focus()
    input.value?.inputRef?.select()
  }
  search()
})
useMutationObserver(
  () => props.root,
  () => {
    clearTimeout(timer)
    timer = setTimeout(search, 100)
  },
  { subtree: true, childList: true, characterData: true },
)
useEventListener(() => props.root, "scroll", schedulePaint, { passive: true, capture: true })
useResizeObserver(() => props.root, schedulePaint)
onScopeDispose(() => {
  clearTimeout(timer)
  cancelAnimationFrame(frame)
})
</script>
<template>
  <svg v-if="open" class="page-find-marks" aria-hidden="true">
    <rect
      v-for="(mark, i) in marks"
      :key="i"
      :x="mark.x"
      :y="mark.y"
      :width="mark.width"
      :height="mark.height"
      :class="{ current: mark.active }"
      rx="1"
    />
  </svg>
  <Transition name="page-find">
    <form
      v-if="open"
      class="page-find"
      :aria-label="t('ui.findOnThisPage')"
      @submit.prevent="next(1)"
      @keydown.esc.stop.prevent="open = false"
    >
      <UInput
        ref="input"
        v-model="query"
        :placeholder="t('ui.findOnThisPage')"
        :aria-label="t('ui.findOnThisPage')"
        @keydown.enter.shift.prevent="next(-1)"
      />
      <span class="text-xs muted" role="status">{{
        matches.length ? `${index + 1}/${matches.length}${matches.length === 500 ? "+" : ""}` : "0/0"
      }}</span>
      <UButton
        icon="i-lucide-chevron-up"
        :aria-label="t('ui.previousMatch')"
        variant="ghost"
        color="neutral"
        :disabled="!matches.length"
        @click="next(-1)"
      />
      <UButton
        icon="i-lucide-chevron-down"
        :aria-label="t('ui.nextMatch')"
        variant="ghost"
        color="neutral"
        :disabled="!matches.length"
        @click="next(1)"
      />
      <UButton
        icon="i-lucide-x"
        :aria-label="t('ui.closePageSearch')"
        variant="ghost"
        color="neutral"
        @click="open = false"
      />
    </form>
  </Transition>
</template>
