<script setup lang="ts">
import type { HealthResponse } from "@trawl/client"
import { capacitySegments } from "~/utils/dashboard"

const props = defineProps<{ health: HealthResponse }>()
const segments = computed(() => capacitySegments(props.health.pool))
const status = computed(() => {
  const pool = props.health.pool
  if (pool.draining) return "Draining"
  if (pool.stalled) return "Needs attention"
  if (props.health.status === "starting") return "Starting"
  if (pool.sleeping && !pool.live) return "Sleeping"
  return "Healthy"
})
const description = computed(
  () =>
    `${props.health.pool.total} configured browsers: ${segments.value.map((segment) => `${segment.value} ${segment.label.toLowerCase()}`).join(", ")}`,
)
</script>
<template>
  <section class="panel" aria-label="Browser capacity">
    <div class="panel-heading">
      <div class="capacity-heading">
        <UIcon name="i-lucide-server" class="size-5 muted" />
        <h2>Browser capacity</h2>
      </div>
      <span class="status"
        ><span class="dot" :class="{ ready: status === 'Healthy', failed: status === 'Needs attention' }" />
        {{ status }}</span
      >
    </div>
    <div class="panel-body">
      <div class="capacity-total">
        <span>Pool allocation</span><span><b class="mono">{{ health.pool.total }}</b> configured</span>
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
          <span><b class="mono">{{ health.pool.queueDepth ?? 0 }}</b> waiting in queue</span>
          <span v-if="health.pool.stalled" class="text-error"
            ><b class="mono">{{ health.pool.stalled }}</b>
            stalled</span
          >
        </div>
        <div class="capacity-footer-group">
          <span><b class="mono">{{ health.pool.live }}</b> live</span>
          <span v-if="health.memory?.workingSetBytes !== undefined"
            >Server working set
            <b class="mono">{{ Math.round(health.memory.workingSetBytes / 1048576).toLocaleString() }} MiB</b></span
          >
        </div>
      </div>
    </div>
  </section>
</template>
