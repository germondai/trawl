<script setup lang="ts">
import type { BrowserSession } from "@trawl/client"
import { useErrorMessage } from "~/composables/useErrorMessage"
import { confirmationContent, useNavigationModal } from "~/composables/useNavigationSteps"
import { formatLocale, LocalizedError, nativeErrorMessage, t } from "~/utils/localization"

const emit = defineEmits<{ use: [id: string] }>()
const desktop = useDesktopStore()
const { sessions, error, loading, refresh } = useSessions()
const busy = shallowRef(false)
const actionError = useErrorMessage()
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
      actionError.value = new LocalizedError("errors.refreshSessions", {
        get error() {
          return nativeErrorMessage(cause) || t("errors.sessionOperation")
        },
      })
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
    <div class="panel-heading" data-tour="sessions">
      <div>
        <h2>{{ t("ui.browserSessions") }}</h2>
        <p class="text-sm muted mt-1">{{ t("ui.reuseCookiesAndBrowserStateAcrossRequests") }}</p>
      </div>
      <div class="actions">
        <UButton
          icon="i-lucide-plus"
          :disabled="!desktop.native || busy || desktop.health?.status !== 'ok'"
          @click="createOpen = true"
          >{{
            t("ui.newSession")
          }}</UButton
        >
      </div>
    </div>
    <div v-if="sessions.length" class="session-toolbar">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        :placeholder="t('ui.searchSessions')"
        :aria-label="t('ui.searchSessions')"
        data-type-focus
        class="min-w-0 flex-1"
        :ui="{ trailing: 'p-0' }"
      >
        <template v-if="search" #trailing
          ><UButton
            class="search-clear"
            color="neutral"
            variant="link"
            icon="i-lucide-x"
            :aria-label="t('ui.clearSessionSearch')"
            @click="search = ''"
          /></template
        >
      </UInput>
      <USelect
        v-model="filter"
        :items="[
          { label: t('ui.allSessions'), value: 'all' },
          { label: t('ui.available'), value: 'available' },
          { label: t('ui.busy'), value: 'busy' },
        ]"
        :aria-label="t('ui.sessionStatus')"
        class="w-40"
      />
    </div>
    <div v-if="!shown.length" class="panel-body empty">
      <UIcon name="i-lucide-layers" class="size-8 muted" />
      <h3 class="mt-3">
        {{
          loading ? t("ui.loadingSessions") : sessions.length ? t("ui.noMatchingSessions") : t("ui.noActiveSessions")
        }}
      </h3>
      <p>
        {{
          sessions.length
            ? t("ui.tryAnotherSearchOrStatus")
            : desktop.health?.status === "ok"
              ? t("ui.createASessionToKeepCookiesBetweenRequests")
              : t("ui.startOrConnectToAnInstanceToManage")
        }}
      </p>
    </div>
    <div v-else class="table-wrap">
      <table class="session-table">
        <thead>
          <tr>
            <th>{{ t("ui.session") }}</th>
            <th>{{ t("ui.status") }}</th>
            <th>{{ t("ui.state") }}</th>
            <th>{{ t("ui.expires") }}</th>
            <th><span class="sr-only">{{ t("ui.actions") }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="session in shown" :key="session.id">
            <td class="mono session-id">{{ session.id }}</td>
            <td>
              <span class="status"
                ><i class="dot" :class="{ ready: !session.busy }" />
                {{ session.busy ? t("ui.busy") : t("ui.available") }}</span
              >
            </td>
            <td>{{ session.keepPage ? t("ui.pageAndCookies") : t("ui.cookies") }}</td>
            <td>
              <AppTooltip :text="new Date(session.expiresAt).toLocaleString(formatLocale(), { timeZoneName: 'short' })"
                ><time :datetime="new Date(session.expiresAt).toISOString()">{{
                  new Date(session.expiresAt).toLocaleTimeString(formatLocale())
                }}</time></AppTooltip
              >
            </td>
            <td>
              <div class="actions justify-end">
                <UButton
                  color="neutral"
                  variant="outline"
                  :disabled="busy || session.busy"
                  @click="emit('use', session.id)"
                  >{{
                    t("ui.useInRequest")
                  }}</UButton
                >
                <UButton
                  icon="i-lucide-trash-2"
                  color="neutral"
                  variant="ghost"
                  :aria-label="t('ui.closeSession', { p0: session.id })"
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
      {{ sessions.length }} {{ t("ui.active2") }} {{ available }} {{ t("ui.available2") }} {{ retained }}
      {{ t("ui.retainedPages") }}
    </div>
  </section>
  <SessionActivity />
  <AppDialog
    v-model:open="createOpen"
    :title="t('ui.newBrowserSession')"
    :description="t('ui.useItsIdInARequestToReuse')"
    :dismissible="!busy"
    :close="{ disabled: busy }"
  >
    <template #body>
      <form id="create-session" class="form-stack" @submit.prevent="change()">
        <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
        <UFormField :label="t('ui.sessionId')" :description="t('ui.optionalLeaveEmptyToGenerateAnId')"
          ><UInput
            v-model="name"
            class="w-full"
            :maxlength="128"
            pattern="[A-Za-z0-9_-]+"
            :placeholder="t('ui.generatedAutomatically')"
            :disabled="busy"
          /></UFormField
        >
        <UFormField
          class="preference-row"
          :ui="{ container: 'preference-control' }"
          :label="t('ui.retainBrowserPage')"
          :description="t('ui.keepOnePageOpenForThisSessionTurn')"
          ><USwitch v-model="keepPage" :disabled="busy" :aria-label="t('ui.retainBrowserPage')" /></UFormField
        >
      </form>
    </template>
    <template #footer
      ><UButton color="neutral" variant="outline" :disabled="busy" @click="createOpen = false">{{
        t("ui.cancel")
      }}</UButton><UButton
        form="create-session"
        type="submit"
        :loading="busy"
        :disabled="!desktop.native || desktop.health?.status !== 'ok'"
        >{{
          t("ui.createSession")
        }}</UButton
      ></template
    >
  </AppDialog>
  <p v-if="error || (!createOpen && actionError)" class="notice error" role="alert">{{ error || actionError }}</p>
  <AppDialog
    :open="Boolean(selected)"
    :content="confirmationContent"
    :title="t('ui.closeThisSession')"
    :description="t('ui.closeItsRetainedPageAndCookiesRequestsUsing', { p0: selected?.id ?? '' })"
    @update:open="if (!$event) selected = undefined;"
  >
    <template #footer
      ><UButton color="neutral" variant="outline" @click="selected = undefined">{{ t("ui.cancel") }}</UButton
      ><UButton data-confirm-default color="error" @click="change(true)">{{ t("ui.closeSession2") }}</UButton></template
    >
  </AppDialog>
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
