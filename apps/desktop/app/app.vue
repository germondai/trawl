<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { movePage, type Page, type PageHistory, visitPage } from "~/utils/page-history"

const desktop = useDesktopStore()
const history = shallowRef<PageHistory>({ entries: ["overview"], index: 0 })
const openRequestId = shallowRef<string>()
const page = computed(() => history.value.entries[history.value.index]!)
const pendingAction = shallowRef<(() => void) | null>(null)
function guard(action: () => void) {
  if (desktop.settingsDirty) pendingAction.value = action
  else action()
}
function acceptDiscard() {
  const action = pendingAction.value
  pendingAction.value = null
  action?.()
}
function move(direction: -1 | 1) {
  const next = movePage(history.value, direction)
  if (next !== history.value)
    guard(() => {
      history.value = next
    })
}
const sidebarOpen = shallowRef(false)
const workspacePane = useTemplateRef<HTMLElement>("workspacePane")
const workspaceScroll = useTemplateRef<HTMLElement>("workspaceScroll")
const { y: scrollY } = useScroll(workspaceScroll)
const workspaceOverlays = computed(() => {
  const content = {
    collisionBoundary: workspacePane.value ?? undefined,
    collisionPadding: 12,
    sideOffset: 8,
    sticky: "always" as const,
  }
  return {
    dropdownMenu: { content: { ...content, align: "end" as const } },
    popover: { content },
    select: { content },
    tooltip: { content },
  }
})
const nativeMac = desktop.native && /Mac/.test(navigator.platform)
useNativeShell()
const closePrompt = shallowRef(false)
const restartPrompt = shallowRef(false)
function navigate(next: Page) {
  if (next === page.value) {
    sidebarOpen.value = false
    return
  }
  guard(() => {
    history.value = visitPage(history.value, next)
    sidebarOpen.value = false
  })
}
function selectInstance(id: string) {
  if (id !== desktop.activeId)
    guard(() => {
      void desktop.select(id)
    })
}
function requestClose(behavior: string) {
  guard(() => {
    if (behavior === "tray" || behavior === "quit") void close(behavior)
    else closePrompt.value = true
  })
}
async function restart() {
  restartPrompt.value = false
  await desktop.action(async () => {
    await desktop.management({ action: "stop" })
    await invoke("server_start")
  })
}
const remember = shallowRef(true)
const visible = useDocumentVisibility()
const unlisteners: UnlistenFn[] = []
const { pause, resume } = useIntervalFn(
  () => {
    void desktop.refresh()
  },
  5000,
  { immediate: false },
)
watch(visible, (state) => {
  if (state === "visible") {
    resume()
    void desktop.refresh()
  } else pause()
})
let disposed = false
onMounted(async () => {
  if (!desktop.native) return
  const attach = async (event: string, handler: (payload: string) => void) => {
    const unlisten = await listen<string>(event, (event) => handler(event.payload))
    if (disposed) unlisten()
    else unlisteners.push(unlisten)
  }
  await Promise.all([
    attach("runtime-error", (payload) => {
      desktop.error = String(payload)
    }),
    attach("close-requested", requestClose),
  ])
  if (disposed) return
  await desktop.action(() => desktop.bootstrap())
  if (!disposed && visible.value === "visible") resume()
})
onBeforeUnmount(() => {
  disposed = true
  pause()
  for (const unlisten of unlisteners) unlisten()
})
async function close(behavior: "tray" | "quit", rememberChoice = false) {
  if (rememberChoice && remember.value && desktop.loaded && desktop.config.desktop.closeBehavior !== behavior) {
    const config = structuredClone(toRaw(desktop.config))
    config.desktop.closeBehavior = behavior
    await desktop.save(config)
    if (desktop.error) return
  }
  closePrompt.value = false
  await invoke("close_window", { behavior })
}
</script>
<template>
  <UApp>
    <UDashboardGroup
      unit="rem"
      storage="local"
      storage-key="trawl-desktop"
      class="desktop-shell"
      data-native-window-chrome
      :class="{ 'native-mac': nativeMac }"
    >
      <ShellSidebar v-model:open="sidebarOpen" :page="page" @navigate="navigate" @select="selectInstance" />
      <main class="workspace-inset" data-native-workspace>
        <UTheme
          :props="workspaceOverlays"
          :ui="{
            dropdownMenu: { content: 'max-w-(--reka-dropdown-menu-content-available-width)' },
            popover: {
              content:
                'max-w-(--reka-popover-content-available-width) max-h-(--reka-popover-content-available-height) overflow-auto',
            },
            select: { content: 'max-w-(--reka-select-content-available-width)' },
            tooltip: { content: 'max-w-(--reka-tooltip-content-available-width)' },
          }"
        >
          <section ref="workspacePane" class="workspace">
            <ShellHeader
              :page="page"
              :scrolled="scrollY > 0"
              :can-back="history.index > 0"
              :can-forward="history.index < history.entries.length - 1"
              :native-mac="nativeMac"
              @back="move(-1)"
              @forward="move(1)"
              @restart="restartPrompt = true"
            />
            <div ref="workspaceScroll" class="workspace-scroll">
              <div class="content">
                <div v-if="!desktop.native" class="notice">
                  Desktop preview. Open the native application to manage the browser, server and saved instances.
                </div>
                <div v-if="desktop.error" class="notice error" role="alert">{{ desktop.error }}</div>
                <InstanceOverview
                  v-if="page === 'overview' || page === 'history'"
                  :history="page === 'history'"
                  :open-request-id="openRequestId"
                  @close-request="openRequestId = undefined"
                  @show-all="navigate('history')"
                />
                <RequestWorkbench
                  v-else-if="page === 'workbench'"
                  @history="
                    openRequestId = $event;
                    navigate('history');
                  "
                />
                <template v-else-if="page === 'browser'"
                  ><BrowserInspector
                    @workbench="navigate('workbench')"
                    @history="
                      openRequestId = $event;
                      navigate('history');
                    "
                  />
                  <BrowserManager v-if="desktop.activeId === 'local'" />
                  <div v-else class="notice">
                    Browser installations are managed on their host. Select Local instance to manage this device.
                  </div></template
                >
                <template v-else-if="page === 'settings'"
                  ><ServerSettings v-if="desktop.activeId === 'local' && (!desktop.native || desktop.loaded)" />
                  <div v-else-if="desktop.activeId === 'local'" class="notice">
                    Local configuration is not loaded yet.
                    <UButton
                      color="neutral"
                      variant="link"
                      :loading="desktop.busy"
                      @click="desktop.action(() => desktop.bootstrap())"
                      >Load configuration</UButton
                    >
                  </div>
                  <RemoteSettings v-else /></template
                >
                <template v-else-if="page === 'logs'"><ServerLogs /></template>
                <template v-else-if="page === 'connections'"
                  ><ConnectionSettings v-if="!desktop.native || desktop.loaded" />
                  <div v-else class="notice">
                    Load the local configuration before editing connections.
                    <UButton
                      color="neutral"
                      variant="link"
                      :loading="desktop.busy"
                      @click="desktop.action(() => desktop.bootstrap())"
                      >Load configuration</UButton
                    >
                  </div></template
                >
              </div>
            </div>
            <div id="settings-save-slot" />
          </section>
        </UTheme>
      </main>
    </UDashboardGroup>
    <UModal
      v-model:open="closePrompt"
      title="Keep TRAWL running?"
      description="Choose what happens when you close the window. You can change this in Connections."
      :dismissible="false"
      ><template #body
        ><p>
          Keeping TRAWL in the tray leaves the local server available. Quit stops the server started by this
          application.
        </p>
        <USwitch
          v-model="remember"
          label="Remember my choice"
          :disabled="!desktop.loaded || desktop.busy"
          class="mt-6"
        />
        <p v-if="!desktop.loaded" class="mt-2 text-sm">
          Preferences are still loading. This choice will apply to this close only.
        </p></template
      ><template #footer
        ><div class="actions">
          <UButton color="neutral" variant="ghost" @click="closePrompt = false">Cancel</UButton
          ><UButton color="neutral" variant="outline" @click="close('quit', true)">Quit completely</UButton
          ><UButton @click="close('tray', true)">Keep running in tray</UButton>
        </div></template
      ></UModal
    >
    <UModal
      :open="Boolean(pendingAction)"
      title="Discard unsaved settings?"
      description="Your changes have not been saved."
      @update:open="if (!$event) pendingAction = null;"
    >
      <template #footer
        ><UButton color="neutral" variant="outline" @click="pendingAction = null">Keep editing</UButton
        ><UButton @click="acceptDiscard">Discard changes</UButton></template
      >
    </UModal>
    <UModal
      v-model:open="restartPrompt"
      title="Restart the local server?"
      description="The server will stop accepting requests while it restarts. Unsaved settings will not be applied."
    >
      <template #footer
        ><UButton color="neutral" variant="outline" @click="restartPrompt = false">Cancel</UButton
        ><UButton :loading="desktop.busy" @click="restart">Restart server</UButton></template
      >
    </UModal>
  </UApp>
</template>
