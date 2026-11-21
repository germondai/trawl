<script setup lang="ts">
import UModal from "@nuxt/ui/components/Modal.vue"
import { useNavigationSelection } from "~/composables/useNavigationSteps"
import { appTourSteps, type TourRect, tourPlacement } from "~/utils/app-tour"
import { formatLocale, t } from "~/utils/localization"
import type { Page } from "~/utils/page-history"

const emit = defineEmits<{ close: []; navigate: [page: Page, step: string] }>()
const desktop = useDesktopStore()
const { phone } = useAppLayout()
const steps = computed(() =>
  appTourSteps(phone.value, desktop.mobile && desktop.activeId === "local", desktop.activeId !== "local"),
)
const stepId = shallowRef(steps.value[0]!.id)
useNavigationSelection("app-tour-step", stepId, {
  transient: true,
  valid: (id) => steps.value.some((step) => step.id === id),
})
const index = computed(() =>
  Math.max(
    0,
    steps.value.findIndex((step) => step.id === stepId.value),
  ),
)
const current = computed(() => steps.value[index.value]!)
const card = useTemplateRef<HTMLElement>("card")
const copy = useTemplateRef<HTMLElement>("copy")
const cardHeight = shallowRef(300)
const minimumHeight = shallowRef(140)
function measureCard() {
  cardHeight.value =
    (card.value?.offsetHeight ?? 300) + Math.max(0, (copy.value?.scrollHeight ?? 0) - (copy.value?.clientHeight ?? 0))
  minimumHeight.value = (card.value?.offsetHeight ?? 140) - (copy.value?.clientHeight ?? 0) + 48
}
useResizeObserver([card, copy], measureCard)
const windowSize = useWindowSize()
const bounds = shallowRef({ x: 0, y: 56, width: window.innerWidth, height: window.innerHeight - 56 })
function collisionBounds() {
  const viewport = window.visualViewport
  const x = viewport?.offsetLeft ?? 0,
    y = viewport?.offsetTop ?? 0
  const width = viewport?.width ?? window.innerWidth
  const bottom = y + (viewport?.height ?? window.innerHeight)
  const header = document.querySelector(".workspace-navbar")?.getBoundingClientRect()
  const navigation = document.querySelector(".mobile-navigation")?.getBoundingClientRect()
  const top = Math.max(y, header?.bottom ?? y)
  return { x, y: top, width, height: Math.max(80, Math.min(bottom, navigation?.top ?? bottom) - top) }
}
const target = shallowRef<TourRect>({ x: 16, y: 80, width: 32, height: 32 })
const ready = shallowRef(false)
const maskId = `tour-${useId().replace(/:/g, "")}`
const anchor = shallowRef<HTMLElement>()
let generation = 0
let frame = 0
let restoreScrollSpace: (smooth?: boolean) => void = () => {}
function measure() {
  bounds.value = collisionBounds()
  if (!anchor.value?.isConnected) return
  const r = anchor.value.getBoundingClientRect()
  const padding = 5
  const x = Math.max(4, r.x - padding),
    y = Math.max(4, r.y - padding)
  target.value = {
    x,
    y,
    width: Math.max(0, Math.min(window.innerWidth - 4, r.right + padding) - x),
    height: Math.max(0, Math.min(window.innerHeight - 4, r.bottom + padding) - y),
  }
}
function scheduleMeasure() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(measure)
}
async function locate() {
  const attempt = ++generation
  ready.value = false
  restoreScrollSpace()
  restoreScrollSpace = () => {}
  anchor.value = undefined
  await nextTick()
  // Wait for the page transition and responsive navigation to mount its anchor.
  for (let i = 0; i < 20 && attempt === generation; i++) {
    anchor.value = [...document.querySelectorAll<HTMLElement>(`[data-tour="${current.value.target}"]`)].find(
      (element) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden",
    )
    if (anchor.value) break
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  if (attempt !== generation) return
  anchor.value ??= document.querySelector<HTMLElement>('[data-tour="page-title"]') ?? undefined
  if (anchor.value && !anchor.value.closest(".workspace-navbar, .desktop-sidebar, .mobile-navigation")) {
    const scroll = anchor.value.closest<HTMLElement>(".workspace-scroll")
    for (const animation of scroll?.getAnimations() ?? []) if (animation.id === "trawl-tour-scroll") animation.cancel()
    anchor.value.scrollIntoView({ block: phone.value ? "start" : "center", behavior: "instant" })
    if (scroll) {
      const safe = collisionBounds(),
        rect = anchor.value.getBoundingClientRect()
      if (phone.value && rect.top > safe.y + 16) {
        const missing = rect.top - safe.y - 16
        const previous = scroll.style.paddingBottom
        const priority = scroll.style.getPropertyPriority("padding-bottom")
        const padding = Number.parseFloat(getComputedStyle(scroll).paddingBottom) || 0
        scroll.style.paddingBottom = `${padding + missing}px`
        restoreScrollSpace = (smooth = false) => {
          // Removing the extra room at once clamps scrollTop and visibly jumps the page.
          if (smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
            const animation = scroll.animate(
              { paddingBottom: [`${padding + missing}px`, `${padding}px`] },
              { duration: 200, easing: "ease-out" },
            )
            animation.id = "trawl-tour-scroll"
          }
          previous
            ? scroll.style.setProperty("padding-bottom", previous, priority)
            : scroll.style.removeProperty("padding-bottom")
        }
        scroll.scrollTop += missing
      } else if (rect.bottom > safe.y + safe.height - 16) scroll.scrollTop += rect.bottom - (safe.y + safe.height - 16)
      else if (rect.top < safe.y + 16) scroll.scrollTop -= safe.y + 16 - rect.top
    }
  }
  await nextTick()
  if (attempt !== generation) return
  measure()
  await nextTick()
  measureCard()
  await nextTick()
  if (attempt !== generation) return
  ready.value = true
}
useResizeObserver(anchor, scheduleMeasure)
useEventListener(window, "resize", scheduleMeasure)
useEventListener(window.visualViewport, "resize", scheduleMeasure)
useEventListener(window.visualViewport, "scroll", scheduleMeasure)
useEventListener(document, "scroll", scheduleMeasure, { capture: true, passive: true })
watch([stepId, phone], locate, { flush: "post" })
onMounted(() => {
  emit("navigate", current.value.page, stepId.value)
  void locate()
})
onScopeDispose(() => {
  generation++
  cancelAnimationFrame(frame)
  restoreScrollSpace(true)
})
const position = computed(() =>
  tourPlacement(
    target.value,
    { width: 360, height: cardHeight.value, minHeight: minimumHeight.value },
    bounds.value,
    current.value.placement,
  ),
)
const style = computed(() => ({
  left: `${position.value.x}px`,
  top: `${position.value.y}px`,
  width: `${position.value.width}px`,
  maxHeight: `${position.value.maxHeight ?? Math.max(48, bounds.value.height - 32)}px`,
  opacity: ready.value ? 1 : 0,
}))
const content = computed(() => ({ style: style.value, onEscapeKeyDown: () => emit("close") }))
function go(offset: number) {
  const next = steps.value[index.value + offset]
  if (next) {
    ready.value = false
    emit("navigate", next.page, next.id)
  } else if (offset > 0) emit("close")
}
</script>
<template>
  <Teleport to="body">
    <svg class="tour-spotlight" aria-hidden="true" :width="windowSize.width.value" :height="windowSize.height.value">
      <defs>
        <mask :id="maskId">
          <rect width="100%" height="100%" fill="white" />
          <rect v-if="ready" v-bind="target" rx="10" fill="black" />
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgb(0 0 0 / .62)" :mask="`url(#${maskId})`" />
      <rect v-if="ready" v-bind="target" rx="10" fill="none" stroke="var(--ui-primary)" stroke-width="2" />
    </svg>
  </Teleport>
  <UModal
    :open="true"
    :overlay="false"
    :dismissible="false"
    :transition="false"
    :title="current.title"
    :description="current.description"
    :content="content"
    :ui="{ content: ['tour-popover top-0 left-0 translate-x-0 translate-y-0', !ready && 'tour-positioning'] }"
  >
    <template #content>
      <section
        ref="card"
        class="tour-card"
        :lang="formatLocale()"
        @keydown.left.prevent="go(-1)"
        @keydown.right.prevent="go(1)"
      >
        <div class="tour-heading">
          <span class="text-xs muted">{{ t("tour.name") }}</span>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            :aria-label="t('tour.close')"
            @click="emit('close')"
          />
        </div>
        <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users can scroll tour text while its actions stay visible. -->
        <section ref="copy" :key="stepId" class="tour-copy" aria-live="polite" :aria-label="current.title" tabindex="0">
          <h2>{{ current.title }}</h2>
          <p>{{ current.description }}</p>
          <p class="text-sm muted">{{ current.detail }}</p>
        </section>
        <div class="tour-controls">
          <span class="text-xs muted">{{ t("tour.progress", { current: index + 1, total: steps.length }) }}</span>
          <div class="actions">
            <UButton v-if="index" color="neutral" variant="ghost" @click="go(-1)">{{ t("tour.back") }}</UButton
            ><UButton @click="go(1)"
              >{{ t(index === steps.length - 1 ? "tour.finish" : "tour.next")
              }}<UIcon name="i-lucide-arrow-right" class="size-4" /></UButton
            >
          </div>
        </div>
      </section>
    </template>
  </UModal>
</template>
<style>
.tour-spotlight {
  position: fixed;
  inset: 0;
  z-index: 100;
  pointer-events: auto;
}
.tour-popover {
  position: fixed;
  z-index: 101;
  margin: 0;
  max-width: none;
  max-height: calc(100dvh - 32px);
  overflow: hidden;
  transition: opacity 120ms ease;
}
.tour-popover.tour-positioning {
  transition: none;
  pointer-events: none;
}
.tour-card {
  padding: 20px;
  display: flex;
  flex-direction: column;
  max-height: inherit;
}
.tour-copy {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.tour-heading,
.tour-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.tour-heading {
  margin: -6px -6px 10px 0;
}
.tour-copy h2 {
  font-size: 18px;
  line-height: 1.35;
  font-weight: 500;
  margin-bottom: 12px;
}
.tour-copy p {
  line-height: 1.6;
  margin-top: 10px;
}
.tour-controls {
  margin-top: 20px;
}
@media (prefers-reduced-motion: reduce) {
  .tour-popover {
    transition: none;
  }
}
</style>
