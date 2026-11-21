<script setup lang="ts">
import type { RequestDiagnostics } from "@trawl/client"
import { formatLocale, t } from "~/utils/localization"

const props = defineProps<{ diagnostics?: RequestDiagnostics; durationMs: number }>()
const stages = computed(() =>
  (props.diagnostics?.stages ?? [])
    .map((stage, index) => ({
      ...stage,
      index,
      offset: Math.max(0, Date.parse(stage.startedAt) - Date.parse(props.diagnostics?.startedAt ?? stage.startedAt)),
    }))
    .sort((a, b) => a.offset - b.offset || a.index - b.index),
)
const scale = computed(() =>
  Math.max(1, props.durationMs, ...stages.value.map((stage) => stage.offset + stage.durationMs)),
)
const ms = (value: number) => `${value.toLocaleString(formatLocale())} ${t("ui.ms")}`
</script>
<template>
  <div class="form-stack">
    <div class="flex justify-between">
      <h3>{{ t("ui.totalDuration") }}</h3>
      <span class="mono">{{ ms(durationMs) }}</span>
    </div>
    <div v-if="stages.length" class="form-stack">
      <div v-for="stage in stages" :key="stage.index" class="execution-stage">
        <div class="flex justify-between gap-3">
          <span
            >{{ t(`diagnostics.stage.${stage.kind}`) }}{{ stage.tier ? ` · ${t("ui.tier")} ${stage.tier}` : "" }}</span
          ><span class="mono">{{ ms(stage.durationMs) }}</span>
        </div>
        <div class="execution-track" aria-hidden="true">
          <div
            :style="{
              marginLeft: `${(stage.offset / scale) * 100}%`,
              width: `${Math.max(0.5, (stage.durationMs / scale) * 100)}%`,
            }"
          />
        </div>
        <p class="text-xs muted">
          {{ t("diagnostics.started") }} +{{ ms(stage.offset) }} ·
          {{ new Date(stage.startedAt).toLocaleTimeString(formatLocale(), { timeZoneName: "short" }) }} ·
          {{ stage.status }} ·
          {{
            ((stage.durationMs / Math.max(1, durationMs)) * 100).toLocaleString(formatLocale(), {
              maximumFractionDigits: 1,
            })
          }}%
        </p>
        <p v-if="stage.reason" class="text-xs mono">{{ stage.reason }}</p>
      </div>
      <p class="text-xs muted">{{ t("diagnostics.overlap") }}</p>
    </div>
    <div v-for="(attempt, index) in diagnostics?.timings ?? []" :key="index" class="execution-attempt">
      <span>{{ t("ui.tier") }} {{ attempt.tier }} · {{ attempt.status }}</span
      ><span class="mono">{{ ms(attempt.durationMs) }}</span>
      <p v-if="attempt.reason" class="text-xs mono execution-reason">
        {{ t("diagnostics.reason") }}: {{ attempt.reason }}
      </p>
    </div>
    <p v-if="!stages.length" class="text-xs muted">{{ t("diagnostics.legacyTiming") }}</p>
  </div>
</template>
<style scoped>
.execution-stage {
  display: grid;
  gap: 6px;
  font-size: 13px;
}
.execution-track {
  height: 6px;
  overflow: hidden;
  background: var(--ui-bg-elevated);
  border-radius: 4px;
}
.execution-track > div {
  height: 100%;
  background: var(--ui-primary);
  border-radius: inherit;
}
.execution-attempt {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  font-size: 13px;
}
.execution-reason {
  grid-column: 1 / -1;
  overflow-wrap: anywhere;
}
</style>
