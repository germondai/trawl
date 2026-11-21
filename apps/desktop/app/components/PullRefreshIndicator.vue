<script setup lang="ts">
import { t } from "~/utils/localization"
import { pullRefreshThreshold } from "~/utils/pull-refresh"

const { distance, refreshing } = defineProps<{ distance: number; refreshing: boolean }>()
const progress = computed(() => (refreshing ? 1 : Math.min(1, distance / pullRefreshThreshold) ** 1.3))
</script>
<template>
  <div
    class="pull-refresh-indicator"
    :class="{ visible: distance > 0 || refreshing, settling: distance === 0 || refreshing }"
    :style="{
      '--pull-distance': `${refreshing ? pullRefreshThreshold : distance}px`,
      '--pull-threshold': `${pullRefreshThreshold}px`,
    }"
    role="status"
    :aria-label="
      refreshing
        ? t('ui.refreshingPage')
        : distance >= pullRefreshThreshold
          ? t('ui.releaseToRefresh')
          : t('ui.pullToRefresh')
    "
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      :class="{ 'animate-spin': refreshing }"
      :style="{ '--draw-progress': progress }"
      aria-hidden="true"
    >
      <path pathLength="1" d="M3 11a9 9 0 0 1 15.36-6.36L21 7M21 3v4h-4" />
      <path pathLength="1" d="M21 13a9 9 0 0 1-15.36 6.36L3 17M7 17H3v4" />
    </svg>
  </div>
</template>
