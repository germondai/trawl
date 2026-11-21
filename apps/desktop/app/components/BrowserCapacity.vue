<script setup lang="ts">
import type { HealthResponse } from "@trawl/client"
import { capacitySegments } from "~/utils/dashboard"
import { formatLocale, t } from "~/utils/localization"

const props = defineProps<{ health: HealthResponse }>()
const segments = computed(() => capacitySegments(props.health.pool))
const statusKey = computed(() => {
  const pool = props.health.pool
  if (pool.draining) return "ui.draining"
  if (pool.stalled) return "ui.needsAttention"
  if (props.health.status === "starting") return "ui.starting"
  if (pool.sleeping && !pool.live) return "ui.sleeping"
  return "ui.healthy"
})
const description = computed(() =>
  t("browser.capacitySummary", {
    count: props.health.pool.total,
    summary: segments.value.map((segment) => `${segment.value} ${segment.label}`).join(", "),
  }),
)
</script>
<template>
  <section class="panel" :aria-label="t('ui.browserCapacity')">
    <div class="panel-heading">
      <div class="capacity-heading">
        <UIcon name="i-lucide-server" class="size-5 muted" />
        <h2>{{ t("ui.browserCapacity") }}</h2>
      </div>
      <span class="status"
        ><span class="dot" :class="{ ready: statusKey === 'ui.healthy', failed: statusKey === 'ui.needsAttention' }" />
        {{ t(statusKey) }}</span
      >
    </div>
    <div class="panel-body">
      <div class="capacity-total">
        <span>{{ t("ui.poolAllocation") }}</span
        ><span><b class="mono">{{ health.pool.total }}</b> {{ t("ui.configured") }}</span>
      </div>
      <div class="capacity-track" role="img" :aria-label="description">
        <span
          v-for="segment in segments"
          :key="segment.key"
          v-show="segment.value > 0"
          :class="segment.key"
          :style="{ width: `${segment.percent}%` }"
        />
      </div>
      <dl class="capacity-counts">
        <div v-for="segment in segments" :key="segment.key">
          <dt><span class="capacity-dot" :class="segment.key" />{{ segment.label }}</dt>
          <dd class="mono">{{ segment.value }}</dd>
        </div>
      </dl>
      <div class="capacity-footer">
        <div class="capacity-footer-group">
          <span><b class="mono">{{ health.pool.queueDepth ?? 0 }}</b> {{ t("ui.waitingInQueue") }}</span>
          <span v-if="health.pool.stalled" class="text-error"
            ><b class="mono">{{ health.pool.stalled }}</b>
            {{ t("ui.stalled") }}</span
          >
        </div>
        <div class="capacity-footer-group">
          <span><b class="mono">{{ health.pool.live }}</b> {{ t("ui.live2") }}</span>
          <span v-if="health.memory?.workingSetBytes !== undefined"
            >{{ t("ui.serverWorkingSet") }}
            <b class="mono"
              >{{ Math.round(health.memory.workingSetBytes / 1048576).toLocaleString(formatLocale()) }}
              {{ t("ui.mib") }}</b
            ></span
          >
        </div>
      </div>
    </div>
  </section>
</template>
