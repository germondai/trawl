<script setup lang="ts">
import { type ActivityBucket, activityIndex, activityPoints } from "~/utils/dashboard"
import { formatLocale, t } from "~/utils/localization"

const props = defineProps<{ timeline: ActivityBucket[]; bucketMs: number; rangeMinutes: number }>()
const selected = shallowRef<number | null>(null)
const activeIndex = computed(() => Math.min(selected.value ?? props.timeline.length - 1, props.timeline.length - 1))
const active = computed(() => (selected.value === null ? undefined : props.timeline[activeIndex.value]))
const position = computed(() =>
  props.timeline.length > 1 ? (activeIndex.value / (props.timeline.length - 1)) * 100 : 50,
)
const plot = useTemplateRef<HTMLDivElement>("plot")
const chartReference = computed(() => {
  const element = plot.value
  const fraction = position.value / 100
  return {
    contextElement: element ?? undefined,
    getBoundingClientRect() {
      const bounds = element?.getBoundingClientRect()
      // Anchor to the full plot height so either placement stays outside the curve.
      return bounds ? new DOMRect(bounds.left + bounds.width * fraction, bounds.top, 0, bounds.height) : new DOMRect()
    },
  }
})
const tooltipContent = computed(() => ({
  ariaLabel: accessibleValue.value,
  side: "top" as const,
  sideOffset: 12,
  collisionBoundary: plot.value?.closest<HTMLElement>(".workspace-scroll") ?? undefined,
  collisionPadding: 12,
  hideWhenDetached: true,
}))
const max = computed(() => Math.max(1, ...props.timeline.map((row) => row.requests)))
const requests = computed(() => activityPoints(props.timeline, "requests"))
const failures = computed(() => activityPoints(props.timeline, "failures"))
const time = (value: number) =>
  new Date(value).toLocaleTimeString(formatLocale(), { hour: "2-digit", minute: "2-digit" })
const interval = computed(() =>
  active.value
    ? t("activity.interval", {
        from: time(Date.parse(active.value.minute)),
        to: time(Date.parse(active.value.minute) + props.bucketMs),
      })
    : "",
)
const accessibleValue = computed(() =>
  active.value
    ? t("activity.summary", {
        interval: interval.value,
        requests: t("counts.requests", { count: active.value.requests }),
        failures: active.value.failures,
        average: active.value.requests ? `${active.value.averageMs} ms` : t("activity.notApplicable"),
      })
    : t("ui.selectATimeInterval"),
)
function inspect(event: PointerEvent) {
  const bounds = (event.currentTarget as HTMLInputElement).getBoundingClientRect()
  selected.value = activityIndex(event.clientX, bounds.left, bounds.width, props.timeline.length)
}
function leave(event: PointerEvent) {
  if (document.activeElement !== event.currentTarget) selected.value = null
}
</script>
<template>
  <section class="panel" :aria-label="t('ui.requestActivity')">
    <div class="panel-heading">
      <h2>{{ t("ui.requestActivity") }}</h2>
      <span class="status">{{ t("ui.last") }} {{ rangeMinutes }} {{ t("ui.minutes") }}</span>
    </div>
    <div class="panel-body">
      <template v-if="timeline.length">
        <div class="activity-legend">
          <span><i class="dot ready" />{{ t("ui.requests") }}</span
          ><span v-if="timeline.some((row) => row.failures)"><i class="dot failed" />{{ t("ui.failed") }}</span>
          <span class="activity-hint">{{ t("ui.hoverOrFocusToInspect") }}</span>
        </div>
        <div ref="plot" class="activity-plot">
          <svg
            class="chart"
            viewBox="0 0 1000 180"
            preserveAspectRatio="none"
            role="img"
            :aria-label="t('ui.requestActivityOverTime')"
          >
            <line class="chart-baseline" x1="0" y1="160" x2="1000" y2="160" />
            <line class="chart-grid" x1="0" y1="20" x2="1000" y2="20" />
            <polyline class="chart-line" :points="requests" />
            <polyline
              v-if="timeline.some((row) => row.failures)"
              class="chart-line chart-failures"
              :points="failures"
            />
            <template v-if="active"
              ><line class="chart-cursor" :x1="position * 10" :x2="position * 10" y1="0" y2="160" />
              <circle
                class="chart-point"
                :cx="position * 10"
                :cy="160 - (active.requests / max) * 140"
                r="4"
                vector-effect="non-scaling-stroke"
              /></template
            >
          </svg>
          <input
            class="activity-scrubber"
            type="range"
            min="0"
            :max="timeline.length - 1"
            step="1"
            :value="activeIndex"
            :aria-label="t('ui.inspectActivityInterval')"
            :aria-valuetext="accessibleValue"
            @pointermove="inspect"
            @pointerleave="leave"
            @focus="selected ??= timeline.length - 1"
            @blur="selected = null"
            @input="selected = Number(($event.target as HTMLInputElement).value)"
          />
        </div>
        <AppTooltip
          :open="Boolean(active)"
          :reference="chartReference"
          :content="tooltipContent"
          :ui="{ content: 'activity-tooltip' }"
          @update:open="if (!$event) selected = null;"
        >
          <template #content
            ><template v-if="active">
              <strong>{{ interval }}</strong>
              <div class="activity-tooltip-metrics">
                <span
                  ><LocalizedMessage message="counts.requests" :parameters="{ count: active.requests }"
                    ><template #count
                      ><b class="mono">{{ active.requests.toLocaleString(formatLocale()) }}</b></template
                    ></LocalizedMessage
                  ></span
                >
                <span
                  ><b class="mono">{{ active.failures.toLocaleString(formatLocale()) }}</b> {{ t("ui.failed2") }}</span
                >
                <span class="activity-tooltip-average"
                  >{{ t("ui.average") }}
                  <b class="mono">{{
                    active.requests ? `${active.averageMs.toLocaleString(formatLocale())} ms` : t("ui.notAvailable")
                  }}</b></span
                >
              </div>
            </template></template
          >
        </AppTooltip>
        <div class="chart-caption">
          <span>{{ rangeMinutes }} {{ t("ui.minutesAgo") }}</span><span>{{ t("ui.now") }}</span>
        </div>
      </template>
      <div v-else class="empty">{{ t("ui.noActivityIntervalsAvailable") }}</div>
    </div>
  </section>
</template>
