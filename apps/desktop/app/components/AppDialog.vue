<script setup lang="ts">
import UDrawer from "@nuxt/ui/components/Drawer.vue"
import UModal from "@nuxt/ui/components/Modal.vue"

defineOptions({ inheritAttrs: false })
const open = defineModel<boolean>("open", { default: false })
const { phone } = useAppLayout()
const attrs = useAttrs()
const gesture = useDrawerGesture(open)
function forwarded() {
  if (!phone.value) return attrs
  const { transition, fullscreen, scrollable, ui, ...rest } = attrs
  const slots = (ui ?? {}) as Record<string, string>
  return {
    ...rest,
    close: attrs.close ?? true,
    direction: "bottom",
    handleOnly: true,
    content: { ...((attrs.content ?? {}) as object), ...gesture },
    ui: {
      ...slots,
      content: [slots.content, "app-drawer"],
      container: "min-h-0 overflow-y-auto",
      footer: "flex-row justify-end flex-wrap gap-2",
    },
  }
}
</script>

<template>
  <component :is="phone ? UDrawer : UModal" v-bind="forwarded()" v-model:open="open">
    <template v-for="(_, name) in $slots" #[name]="slotProps"><slot :name="name" v-bind="slotProps ?? {}" /></template>
  </component>
</template>
