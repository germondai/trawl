<script setup lang="ts">
const props = defineProps<{ value?: number | null; max?: number | null; label: string; failedRemainder?: boolean }>()
const known = computed(
  () =>
    props.value != null &&
    props.max != null &&
    Number.isFinite(props.value) &&
    Number.isFinite(props.max) &&
    props.max > 0,
)
const value = computed(() => Math.max(0, Math.min(Number(props.value), Number(props.max))))
const percent = computed(() => (known.value ? (value.value / Number(props.max)) * 100 : 0))
</script>
<template>
  <AppTooltip :text="label"
    ><div
      class="metric-bar"
      :class="{ 'failed-remainder': known && failedRemainder }"
      :role="known ? 'meter' : undefined"
      :aria-label="label"
      :aria-valuemin="known ? 0 : undefined"
      :aria-valuemax="known ? (max ?? undefined) : undefined"
      :aria-valuenow="known ? value : undefined"
      :aria-valuetext="label"
    >
      <span :style="{ width: `${percent}%` }" />
    </div></AppTooltip
  >
</template>
<style scoped>
.metric-bar {
  height: 2px;
  background: var(--ui-border);
  overflow: hidden;
}
.metric-bar.failed-remainder {
  background: var(--ui-error);
}
.metric-bar span {
  display: block;
  height: 100%;
  background: var(--ui-primary);
  transition: width 400ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .metric-bar span {
    transition: none;
  }
}
</style>
