<script setup lang="ts">
import type { BrowserSession } from "@trawl/client"
import { confirmationContent, useNavigationModal } from "~/composables/useNavigationSteps"

const emit = defineEmits<{ use: [id: string] }>()
const desktop = useDesktopStore()
const { sessions, error, loading, refresh } = useSessions()
const busy = shallowRef(false)
const actionError = shallowRef("")
const selected = shallowRef<BrowserSession>()
const name = shallowRef("")
const keepPage = shallowRef(true)
const createOpen = shallowRef(false)
useNavigationModal(createOpen, false)
useNavigationModal(selected, undefined)
const search = shallowRef("")
const filter = shallowRef("all")
watch(createOpen, (open) => {
  if (open) actionError.value = ""
})
const available = computed(() => sessions.value.filter((session) => !session.busy).length)
const retained = computed(() => sessions.value.filter((session) => session.keepPage).length)
const shown = computed(() =>
  sessions.value.filter(
    (session) =>
      session.id.toLowerCase().includes(search.value.trim().toLowerCase()) &&
      (filter.value === "all" || (filter.value === "busy" ? session.busy : !session.busy)),
  ),
)
let controller: AbortController | undefined
async function change(remove = false) {
  if (busy.value) return
  const id = desktop.activeId
  const abort = new AbortController()
  controller = abort
  const session = selected.value
  selected.value = undefined
  busy.value = true
  actionError.value = ""
  try {
    const api = desktop.client()
    if (remove && session) await api.sessions.destroy(session.id, { signal: abort.signal })
    else
      await api.sessions.create(
        { ...(name.value.trim() ? { id: name.value.trim() } : {}), keepPage: keepPage.value },
        { signal: abort.signal, timeoutMs: 40000 },
      )
    if (!abort.signal.aborted && id === desktop.activeId) {
      if (!remove) {
        name.value = ""
        createOpen.value = false
      }
      await refresh()
    }
  } catch (cause) {
    if (!abort.signal.aborted && id === desktop.activeId)
      actionError.value = `${cause instanceof Error ? cause.message : "Session operation failed"}. Refresh sessions before retrying.`
  } finally {
    if (!abort.signal.aborted && id === desktop.activeId) busy.value = false
  }
}
watch(
  () => desktop.activeId,
  () => {
    controller?.abort()
    selected.value = undefined
    createOpen.value = false
    search.value = ""
    filter.value = "all"
    busy.value = false
    actionError.value = ""
  },
)
onScopeDispose(() => controller?.abort())
</script>
<template>
  <section class="panel sessions-panel">
    <div class="panel-heading">
      <div>
        <h2>Browser sessions</h2>
        <p class="text-sm muted mt-1">Reuse cookies and browser state across requests.</p>
      </div>
      <div class="actions">
        <UButton
          icon="i-lucide-plus"
          :disabled="!desktop.native || busy || desktop.health?.status !== 'ok'"
          @click="createOpen = true"
          >New session</UButton
        >
      </div>
    </div>
    <div v-if="sessions.length" class="session-toolbar">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search sessions"
        aria-label="Search sessions"
        class="min-w-0 flex-1"
        :ui="{ trailing: 'p-0' }"
      >
        <template v-if="search" #trailing
          ><UButton
            class="search-clear"
            color="neutral"
            variant="link"
            icon="i-lucide-x"
            aria-label="Clear session search"
            @click="search = ''"
          /></template
        >
      </UInput>
      <USelect
        v-model="filter"
        :items="[
          { label: 'All sessions', value: 'all' },
          { label: 'Available', value: 'available' },
          { label: 'Busy', value: 'busy' },
        ]"
        aria-label="Session status"
        class="w-40"
      />
    </div>
    <div v-if="!shown.length" class="panel-body empty">
      <UIcon name="i-lucide-layers" class="size-8 muted" />
      <h3 class="mt-3">
        {{ loading ? "Loading sessions…" : sessions.length ? "No matching sessions" : "No active sessions" }}
      </h3>
      <p>
        {{
          sessions.length
            ? "Try another search or status."
            : desktop.health?.status === "ok"
              ? "Create a session to keep cookies between requests, with an optional retained browser page."
              : "Start or connect to an instance to manage its browser sessions."
        }}
      </p>
    </div>
    <div v-else class="table-wrap">
      <table class="session-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Status</th>
            <th>State</th>
            <th>Expires</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="session in shown" :key="session.id">
            <td class="mono session-id">{{ session.id }}</td>
            <td>
              <span class="status"
                ><i class="dot" :class="{ ready: !session.busy }" />{{ session.busy ? "Busy" : "Available" }}</span
              >
            </td>
            <td>{{ session.keepPage ? "Page and cookies" : "Cookies" }}</td>
            <td>
              <UTooltip :text="new Date(session.expiresAt).toLocaleString()"
                ><time :datetime="session.expiresAt">{{
                  new Date(session.expiresAt).toLocaleTimeString()
                }}</time></UTooltip
              >
            </td>
            <td>
              <div class="actions justify-end">
                <UButton
                  color="neutral"
                  variant="outline"
                  :disabled="busy || session.busy"
                  @click="emit('use', session.id)"
                  >Use in request</UButton
                >
                <UButton
                  icon="i-lucide-trash-2"
                  color="neutral"
                  variant="ghost"
                  :aria-label="`Close session ${session.id}`"
                  :disabled="busy || session.busy"
                  @click="selected = session"
                />
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="panel-footer muted text-xs">
      {{ sessions.length }} active · {{ available }} available · {{ retained }} retained pages
    </div>
  </section>
  <UModal
    v-model:open="createOpen"
    title="New browser session"
    description="Use its ID in a request to reuse the same browser state."
    :dismissible="!busy"
    :close="{ disabled: busy }"
  >
    <template #body>
      <form id="create-session" class="form-stack" @submit.prevent="change()">
        <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
        <UFormField label="Session ID" description="Optional. Leave empty to generate an ID."
          ><UInput
            v-model="name"
            class="w-full"
            :maxlength="128"
            pattern="[A-Za-z0-9_-]+"
            placeholder="Generated automatically"
            :disabled="busy"
          /></UFormField
        >
        <UFormField
          class="preference-row"
          :ui="{ container: 'preference-control' }"
          label="Retain browser page"
          description="Keep one page open for this session. Turn off to retain only cookies."
          ><USwitch v-model="keepPage" :disabled="busy" /></UFormField
        >
      </form>
    </template>
    <template #footer
      ><UButton color="neutral" variant="outline" :disabled="busy" @click="createOpen = false">Cancel</UButton
      ><UButton
        form="create-session"
        type="submit"
        :loading="busy"
        :disabled="!desktop.native || desktop.health?.status !== 'ok'"
        >Create session</UButton
      ></template
    >
  </UModal>
  <p v-if="error || (!createOpen && actionError)" class="notice error" role="alert">{{ error || actionError }}</p>
  <UModal
    :open="Boolean(selected)"
    :content="confirmationContent"
    title="Close this session?"
    :description="`Close ${selected?.id ?? ''}, its retained page and cookies. Requests using this ID will need a new session.`"
    @update:open="if (!$event) selected = undefined;"
  >
    <template #footer
      ><UButton color="neutral" variant="outline" @click="selected = undefined">Cancel</UButton
      ><UButton data-confirm-default color="error" @click="change(true)">Close session</UButton></template
    >
  </UModal>
</template>
<style scoped>
.session-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--ui-border);
}
.session-table {
  min-width: 720px;
}
.session-id {
  max-width: 300px;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .session-toolbar {
    padding: 16px;
  }
}
</style>
