<script setup lang="ts">
import type { DashboardEvent, RequestHistoryEntry } from "@trawl/client"
import { useNavigationSelection } from "~/composables/useNavigationSteps"
import { executionTier } from "~/utils/dashboard"

const props = defineProps<{ entry: DashboardEvent & Partial<RequestHistoryEntry>; captures: boolean }>()
const emit = defineEmits<{ replay: [] }>()
const tab = shallowRef("headers")
useNavigationSelection("request-inspector", tab, { transient: true })
const tabs = [
  { label: "Headers", value: "headers" },
  { label: "Payload", value: "payload" },
  { label: "Cookies", value: "cookies" },
  { label: "Timing", value: "timing" },
  { label: "Initiator", value: "initiator" },
  { label: "Preview", value: "preview" },
  { label: "Response", value: "response" },
]
const { manifest, loading, error } = useSavedCaptures(() => ({ id: props.entry.id ?? "", at: props.entry.at }))
const request = computed(() => manifest.value?.artifacts.find((artifact) => artifact.kind === "request"))
const diagnostics = computed(() => props.entry.diagnostics)
const bytes = (value?: number) =>
  value === undefined
    ? "Not recorded"
    : value < 1024
      ? `${value} B`
      : `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`
</script>
<template>
  <div class="form-stack">
    <dl class="inspection-facts">
      <div>
        <dt>Source</dt>
        <dd>{{ entry.source }}</dd>
      </div>
      <div>
        <dt>Execution</dt>
        <dd>{{ executionTier(entry.tier) }} <span class="muted">· {{ entry.tier ?? "—" }}</span></dd>
      </div>
      <div>
        <dt>HTTP status</dt>
        <dd class="mono">{{ entry.statusCode ?? "Not recorded" }}</dd>
      </div>
      <div>
        <dt>Challenge</dt>
        <dd>{{ diagnostics?.challenges.join(", ") || (diagnostics ? "None recorded" : "Not recorded") }}</dd>
      </div>
      <div>
        <dt>Result / cause</dt>
        <dd>{{ entry.category ?? entry.tierStatus ?? (entry.success ? "Success" : "Failed") }}</dd>
      </div>
      <div>
        <dt>Response type</dt>
        <dd>{{ diagnostics?.contentType ?? diagnostics?.responseKind ?? "Not recorded" }}</dd>
      </div>
      <div>
        <dt>Request body</dt>
        <dd>{{ bytes(diagnostics?.requestBodyBytes) }}</dd>
      </div>
      <div>
        <dt>Response body</dt>
        <dd>{{ bytes(diagnostics?.responseBytes) }}</dd>
      </div>
    </dl>
    <UTabs
      class="inspection-tabs"
      v-model="tab"
      :items="tabs"
      :content="false"
      variant="link"
      :ui="{ list: 'w-full justify-start', trigger: 'shrink-0' }"
    />
    <dl v-if="tab === 'headers'" class="request-details">
      <div>
        <dt>Request ID</dt>
        <dd class="mono break-all">{{ entry.id ?? "Not recorded" }}</dd>
      </div>
      <div>
        <dt>Method</dt>
        <dd class="mono">{{ entry.method ?? "Not recorded" }}</dd>
      </div>
      <div>
        <dt>Recorded at</dt>
        <dd>{{ new Date(entry.at).toLocaleString() }}</dd>
      </div>
      <div v-if="entry.waf">
        <dt>WAF provider</dt>
        <dd>{{ entry.waf.products.join(", ") || entry.waf.state }}</dd>
      </div>
    </dl>
    <template v-if="tab === 'headers' || tab === 'payload' || tab === 'cookies'">
      <p v-if="error" class="notice" role="status">{{ error }}</p>
      <CapturedRequest
        v-if="captures && entry.id && manifest"
        :request-id="entry.id"
        :request-at="entry.at"
        :artifact="request"
        :view="tab"
        @replay="emit('replay')"
      />
      <p v-else-if="loading" class="text-xs muted" role="status">Loading saved request parameters…</p>
      <p v-else class="text-xs muted">Saved request parameters are unavailable on this instance.</p>
      <p v-if="tab === 'headers' || tab === 'cookies'" class="text-xs muted">
        Response headers and response cookies were not retained with this record.
      </p>
    </template>
    <div v-else-if="tab === 'timing'" class="form-stack">
      <div class="flex justify-between">
        <h3>Total duration</h3>
        <span class="mono">{{ entry.durationMs.toLocaleString() }} ms</span>
      </div>
      <div v-for="(attempt, index) in diagnostics?.timings ?? []" :key="index" class="timing-attempt">
        <span>Tier {{ attempt.tier }} · {{ attempt.status }}</span
        ><span class="mono">{{ attempt.durationMs.toLocaleString() }} ms</span>
        <div class="timing-track">
          <div :style="{ width: `${Math.min(100, (attempt.durationMs / Math.max(1, entry.durationMs)) * 100)}%` }" />
        </div>
      </div>
      <p class="text-xs muted">
        {{
          diagnostics?.timings.length
            ? "Execution time per tier. DNS, connection and transfer phases are not recorded separately."
            : "Per-tier timing was not recorded for this request."
        }}
      </p>
    </div>
    <dl v-else-if="tab === 'initiator'" class="request-details">
      <div>
        <dt>Source</dt>
        <dd>
          {{ entry.source === "flaresolverr" ? "FlareSolverr API · Prowlarr and compatible clients" : entry.source }}
        </dd>
      </div>
      <div>
        <dt>Target</dt>
        <dd>{{ entry.domain }}</dd>
      </div>
      <div>
        <dt>Timestamp (UTC)</dt>
        <dd class="mono break-all">{{ entry.at }}</dd>
      </div>
    </dl>
    <CapturedContent
      v-else-if="captures && entry.id"
      :request-id="entry.id"
      :request-at="entry.at"
      :view="tab === 'response' ? 'source' : 'preview'"
    />
    <p v-else class="text-xs muted">Saved response content is unavailable on this instance.</p>
  </div>
</template>
<style scoped>
.inspection-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px 16px;
  margin: 0;
}
.inspection-facts dt {
  font-size: 12px;
  color: var(--ui-text-muted);
  margin-bottom: 6px;
}
.inspection-facts dd {
  margin: 0;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.timing-attempt {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  font-size: 13px;
}
.timing-track {
  grid-column: 1 / -1;
  height: 5px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--ui-bg-elevated);
}
.timing-track > div {
  background: var(--ui-primary);
  height: 100%;
}
@media (max-width: 720px) {
  .inspection-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
