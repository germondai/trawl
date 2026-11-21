<script setup lang="ts">
import type { TooltipProps } from "@nuxt/ui"
import UTooltip from "@nuxt/ui/components/Tooltip.vue"

defineOptions({ inheritAttrs: false })
const props = defineProps<Omit<TooltipProps, "open" | "defaultOpen">>()
const open = defineModel<boolean>("open", { default: false })
const { enabled, visible, register } = useTooltipLifecycle()
const touchHint = shallowRef(false)
let hold: ReturnType<typeof setTimeout> | undefined
let expiry: ReturnType<typeof setTimeout> | undefined
let origin = { x: 0, y: 0 }
let held = false
function cancelHold() {
  clearTimeout(hold)
}
function startHold(event: PointerEvent) {
  if (event.pointerType !== "touch" || props.disabled) return
  cancelHold()
  clearTimeout(expiry)
  origin = { x: event.clientX, y: event.clientY }
  held = false
  hold = setTimeout(() => {
    held = true
    touchHint.value = true
    open.value = true
    expiry = setTimeout(() => {
      open.value = false
      touchHint.value = false
    }, 2500)
  }, 500)
}
function moveHold(event: PointerEvent) {
  if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancelHold()
}
function click(event: MouseEvent) {
  if (held) {
    event.preventDefault()
    event.stopImmediatePropagation()
    held = false
  }
}
onScopeDispose(() => {
  cancelHold()
  clearTimeout(expiry)
})
watch(
  open,
  (value, _, cleanup) => {
    if (value)
      cleanup(
        register(() => {
          open.value = false
        }),
      )
  },
  { flush: "sync" },
)
watch(
  visible,
  () => {
    open.value = false
  },
  { flush: "sync" },
)
</script>

<template>
  <UTooltip
    v-bind="{ ...props, ...$attrs }"
    v-model:open="open"
    :disabled="props.disabled || !visible || (!enabled && !touchHint)"
    :ignore-non-keyboard-focus="true"
    @pointerdown.capture="startHold"
    @pointermove.capture="moveHold"
    @pointerup.capture="cancelHold"
    @pointercancel.capture="cancelHold"
    @click.capture="click"
    @contextmenu.prevent
  >
    <template v-for="(_, name) in $slots" #[name]="slotProps"><slot :name="name" v-bind="slotProps ?? {}" /></template>
  </UTooltip>
</template>
