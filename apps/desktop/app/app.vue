<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { type ShortcutAction, shortcutDefinitions } from "@trawl/config/catalog"
import { confirmationContent, provideNavigationSteps, useBrowserNavigation } from "~/composables/useNavigationSteps"
import { eventShortcut } from "~/utils/keybindings"
import { cyclePage, type Page } from "~/utils/page-history"
import { type SettingTarget, settingNavigation } from "~/utils/setting-navigation"
import { newWorkbenchDraft, replacesWorkbenchDraft } from "~/utils/workbench"

const desktop = useDesktopStore()
const downloads = useBrowserDownloadsStore()
const nativeShortcuts = desktop.native
const macOS = /Mac/.test(navigator.platform)
const nativeMac = desktop.native && macOS
const kbds = useShortcutKeys()
const quitKeys = computed(() => kbds("quit"))
const navigation = provideNavigationSteps()
usePopupNavigation(navigation)
useCustomScrollbars()
const { canBack, canForward } = navigation
const workbench = useWorkbenchStore()
const openRequestId = shallowRef<string>()
const page = computed(() => navigation.current.value.page)
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
  const next = navigation.peek(direction)
  if (next) moveTo(next.id)
}
function moveTo(id: number) {
  const next = navigation.find(id)
  if (!next) return
  const apply = () => navigation.go(id)
  if (next.page !== page.value) guard(apply)
  else apply()
}
useBrowserNavigation(navigation, moveTo)
const sidebarOpen = shallowRef(false)
const sidebarCollapsed = shallowRef(false)
const commandsOpen = shallowRef(false)
function openCommands() {
  sidebarOpen.value = false
  commandsOpen.value = true
}
useEventListener(window, "resize", () => {
  if (window.matchMedia("(min-width: 1024px)").matches) sidebarOpen.value = false
})
const settingTarget = shallowRef<SettingTarget>()
let settingRevision = 0
function openSetting(name: string) {
  if (!desktop.catalog.some((setting) => setting.name === name)) return
  const open = () => {
    settingTarget.value = { name, revision: ++settingRevision }
    navigation.visit("settings")
    sidebarOpen.value = false
  }
  if (page.value === "settings") open()
  else guard(open)
}
provide(settingNavigation, openSetting)
function toggleSidebar() {
  if (window.matchMedia("(min-width: 1024px)").matches) sidebarCollapsed.value = !sidebarCollapsed.value
  else sidebarOpen.value = !sidebarOpen.value
}
function runShortcut(action: ShortcutAction) {
  if ("scope" in shortcutDefinitions[action]) return
  if (action === "search") openCommands()
  else if (action === "server") {
    if (!desktop.native || desktop.busy || desktop.activeId !== "local") return
    guard(() => {
      if (desktop.status.running) void desktop.stop()
      else if (desktop.browser.installed) void desktop.start()
    })
  } else if (action === "restart") {
    if (!desktop.native || desktop.busy || desktop.activeId !== "local" || !desktop.status.running) return
    guard(() => {
      restartPrompt.value = true
    })
  } else if (action === "sidebar") toggleSidebar()
  else if (action === "refresh") refreshPage()
  else if (action === "workbench") newRequest()
  else if (action === "close" || action === "quit") {
    if (desktop.native) requestClose(action === "quit" ? "quit" : desktop.config.desktop.closeBehavior)
  } else navigate(action as Page)
}
useEventListener(
  window,
  "keydown",
  (event: KeyboardEvent) => {
    if (event.key === "Escape" && quitFeedback.value) {
      event.preventDefault()
      showQuitFeedback("")
      if (desktop.native) void invoke("cancel_quit_gesture").catch(() => {})
      return
    }
    if (document.querySelector("[data-shortcut-recording]")) return
    if (event.code === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      navigate(cyclePage(page.value, event.shiftKey ? -1 : 1))
      return
    }
    if (nativeShortcuts || event.defaultPrevented || event.repeat) return
    const shortcut = eventShortcut(event, macOS)
    const action =
      shortcut &&
      (Object.keys(shortcutDefinitions) as ShortcutAction[]).find(
        (action) => desktop.config.desktop.keybindings[action] === shortcut,
      )
    if (action) {
      event.preventDefault()
      runShortcut(action)
    }
  },
  { capture: true },
)
const workspacePane = useTemplateRef<HTMLElement>("workspacePane")
const workspaceScroll = useTemplateRef<HTMLElement>("workspaceScroll")
const { top: scrollToTop } = useWorkspaceScroll(workspaceScroll)
const pageRefresh = providePageRefresh(async () => {
  if (!desktop.native || desktop.busy) return
  await desktop.bootstrap()
  await desktop.refresh(true)
})
function installBrowser() {
  navigate("browser")
  void desktop.install()
}
function refreshPage() {
  if (!desktop.native || desktop.busy) return
  void pageRefresh.refresh().catch((cause) => {
    useToast().add({ title: "Could not refresh page", description: String(cause), color: "error" })
  })
}
const scrollbarWidth = shallowRef(0)
useResizeObserver(workspaceScroll, () => {
  const element = workspaceScroll.value
  scrollbarWidth.value = element ? element.offsetWidth - element.clientWidth : 0
})
const settingsSaveSlot = useTemplateRef<HTMLElement>("settingsSaveSlot")
const saveBarHeight = shallowRef(0)
useResizeObserver(settingsSaveSlot, ([entry]) => {
  saveBarHeight.value = entry?.contentRect.height ?? 0
})
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
useNativeShell(sidebarOpen)
const quitFeedback = shallowRef("")
const quitArmed = shallowRef(false)
let quitTimer: ReturnType<typeof setTimeout> | undefined
function showQuitFeedback(feedback: string) {
  clearTimeout(quitTimer)
  quitFeedback.value = feedback
  quitArmed.value = false
  if (feedback === "hold")
    quitTimer = setTimeout(() => {
      quitArmed.value = true
    }, 1000)
  else if (feedback === "double")
    quitTimer = setTimeout(() => {
      quitFeedback.value = ""
    }, 750)
}
function mouseNavigate(event: MouseEvent) {
  if (event.button !== 3 && event.button !== 4) return
  event.preventDefault()
  if (event.type === "mouseup") move(event.button === 3 ? -1 : 1)
}
useEventListener(window, "mousedown", mouseNavigate, { capture: true })
useEventListener(window, "mouseup", mouseNavigate, { capture: true })
useEventListener(window, "auxclick", mouseNavigate, { capture: true })
const closePrompt = shallowRef(false)
const restartPrompt = shallowRef(false)
const stopModals = [
  navigation.bindModal(sidebarOpen, false),
  navigation.bindModal(pendingAction, null),
  navigation.bindModal(closePrompt, false),
  navigation.bindModal(restartPrompt, false),
]
watch(
  () => desktop.activeId,
  () => navigation.reset(),
  { flush: "post" },
)
function navigate(next: Page) {
  if (next === page.value) {
    sidebarOpen.value = false
    return
  }
  guard(() => {
    navigation.visit(next, next === "workbench" ? { "workbench-tab": workbench.activeTabId } : {})
    sidebarOpen.value = false
  })
}
function newRequest() {
  guard(() => {
    if (replacesWorkbenchDraft(workbench.draft, newWorkbenchDraft()) && !workbench.addTab()) {
      useToast().add({
        title: "Eight request tabs are already open",
        description: "Close a tab before creating another request.",
        color: "neutral",
      })
    }
    navigation.visit("workbench", { "workbench-tab": workbench.activeTabId })
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
    attach("navigate-requested", (direction) => {
      if (direction === "next-page" || direction === "previous-page")
        navigate(cyclePage(page.value, direction === "next-page" ? 1 : -1))
      else move(direction === "back" ? -1 : 1)
    }),
    attach("page-requested", () => {
      void takePageRequest()
    }),
    attach("refresh-requested", refreshPage),
    attach("quit-feedback", showQuitFeedback),
    attach("instance-requested", () => {
      void takeInstanceRequest()
    }),
  ])
  if (disposed) return
  await desktop.action(() => desktop.bootstrap())
  if (!disposed) {
    const instance = await invoke<string>("tray_instance", { id: null })
    if (instance !== desktop.activeId) await desktop.select(instance)
    await takeInstanceRequest()
  }
  if (!disposed) await takePageRequest()
  if (!disposed && visible.value === "visible") resume()
})
async function takePageRequest() {
  const target = await invoke<string | null>("take_page_request")
  if (!disposed && target && Object.hasOwn(shortcutDefinitions, target)) runShortcut(target as ShortcutAction)
}
async function takeInstanceRequest() {
  const id = await invoke<string | null>("take_instance_request")
  if (!disposed && id) selectInstance(id)
}
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(quitTimer)
  pause()
  for (const unlisten of unlisteners) unlisten()
  for (const stop of stopModals) stop()
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
  <UApp
    ><UTheme :props="{ modal: { transition: false } }">
      <UDashboardGroup
        unit="rem"
        storage="local"
        storage-key="trawl-desktop"
        class="desktop-shell"
        data-native-window-chrome
        :class="{ 'native-mac': nativeMac }"
      >
        <ShellSidebar
          v-model:open="sidebarOpen"
          v-model:collapsed="sidebarCollapsed"
          :page="page"
          @navigate="(next) => (next === 'workbench' ? newRequest() : navigate(next))"
          @select="selectInstance"
          @search="openCommands"
        />
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
                :refreshing="pageRefresh.busy.value"
                :page="page"
                :can-back="canBack"
                :can-forward="canForward"
                :native-mac="nativeMac"
                @back="move(-1)"
                @forward="move(1)"
                @restart="restartPrompt = true"
                @refresh="refreshPage"
              />
              <div
                ref="workspaceScroll"
                class="workspace-scroll"
                :class="{
                  'workspace-fill':
                    page === 'logs' ||
                    page === 'sessions' ||
                    ((page === 'overview' || page === 'history') &&
                      desktop.activeId === 'local' &&
                      !desktop.status.running),
                }"
              >
                <div class="content">
                  <div v-if="!desktop.native" class="notice">
                    Desktop preview. Open the native application to manage the browser, server and saved instances.
                  </div>
                  <div v-if="desktop.error" class="notice error" role="alert">{{ desktop.error }}</div>
                  <p
                    v-if="desktop.activeId === 'local' && desktop.status.running && desktop.status.ready === false"
                    class="notice"
                    role="status"
                  >
                    Starting local server and preparing the browser…
                  </p>
                  <Transition :css="false" @before-enter="scrollToTop(false)"
                    ><div :key="page" class="page-view">
                      <InstanceOverview
                        v-if="page === 'overview' || page === 'history'"
                        :history="page === 'history'"
                        :open-request-id="openRequestId"
                        @close-request="openRequestId = undefined"
                        @show-all="navigate('history')"
                        @replay="navigate('workbench')"
                      />
                      <RequestWorkbench
                        v-else-if="page === 'workbench'"
                        @history="
                          openRequestId = $event;
                          navigate('history');
                        "
                      />
                      <div
                        v-else-if="page === 'sessions' && desktop.mobile && desktop.activeId === 'local'"
                        class="notice"
                      >
                        Android System WebView uses a fresh page for each request. Persistent sessions are unavailable
                        on this device.
                      </div>
                      <SessionManager
                        v-else-if="page === 'sessions'"
                        @use="
                          useWorkbenchStore().draft.sessionId = $event;
                          navigate('workbench');
                        "
                      />
                      <ResourceUsage v-else-if="page === 'resources'" @navigate="navigate" />
                      <template v-else-if="page === 'browser'"
                        ><BrowserInspector
                          v-if="!desktop.mobile || desktop.activeId !== 'local'"
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
                        ><ServerSettings
                          v-if="desktop.activeId === 'local' && (!desktop.native || desktop.loaded)"
                          :focus-setting="settingTarget"
                          @focused="settingTarget = undefined"
                        />
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
                        <RemoteSettings
                          v-else
                          :focus-setting="settingTarget"
                          @focused="settingTarget = undefined"
                        /></template
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
                    </div></Transition
                  >
                </div>
              </div>
              <div id="settings-save-slot" ref="settingsSaveSlot" />
              <TransitionGroup
                name="floating-action"
                tag="div"
                class="floating-actions"
                :style="{ right: `${16 + scrollbarWidth}px`, bottom: `${16 + saveBarHeight}px` }"
              >
                <div v-if="downloads.pending.length && page !== 'browser'" key="downloads">
                  <BrowserDownloadQueue @browse="navigate('browser')" />
                </div>
                <div v-if="page !== 'workbench'" key="request">
                  <UTooltip text="New request" :kbds="kbds('workbench')"
                    ><UButton
                      class="new-request-fab"
                      icon="i-lucide-plus"
                      aria-label="New request"
                      @click="newRequest"
                    /></UTooltip
                  >
                </div>
              </TransitionGroup>
            </section>
          </UTheme>
        </main>
      </UDashboardGroup>
      <ShellCommands
        v-model:open="commandsOpen"
        :page="page"
        @action="runShortcut"
        @setting="openSetting"
        @select="selectInstance"
      />
      <div v-if="quitFeedback" class="quit-hold" role="status">
        <UIcon name="i-lucide-power" class="size-5" />
        <span class="quit-message"
          ><span>{{ quitFeedback === "double" ? "Press" : quitArmed ? "Release" : "Hold" }}</span>
          <span class="inline-flex items-center gap-1"><UKbd v-for="key in quitKeys" :key="key" :value="key" /></span>
          <span>{{ quitFeedback === "double" ? "again to quit TRAWL" : "to quit TRAWL" }}</span>
        </span>
        <span v-if="quitFeedback === 'hold'" class="quit-progress" aria-hidden="true" />
      </div>
      <UModal
        v-model:open="closePrompt"
        :content="confirmationContent"
        title="Keep TRAWL running?"
        description="Choose what happens when you close the window. You can change this in App settings."
        :dismissible="false"
        ><template #body
          ><p>
            Keeping TRAWL running leaves the local server available. Quit stops the server started by this application.
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
            ><UButton data-confirm-default @click="close('tray', true)">Keep running</UButton>
          </div></template
        ></UModal
      >
      <UModal
        :open="Boolean(pendingAction)"
        :content="confirmationContent"
        title="Discard unsaved settings?"
        description="Your changes have not been saved."
        @update:open="if (!$event) pendingAction = null;"
      >
        <template #footer
          ><UButton color="neutral" variant="outline" @click="pendingAction = null">Keep editing</UButton
          ><UButton data-confirm-default @click="acceptDiscard">Discard changes</UButton></template
        >
      </UModal>
      <UModal
        v-model:open="restartPrompt"
        :content="confirmationContent"
        title="Restart the local server?"
        description="The server will stop accepting requests while it restarts. Unsaved settings will not be applied."
      >
        <template #footer
          ><UButton color="neutral" variant="outline" @click="restartPrompt = false">Cancel</UButton
          ><UButton data-confirm-default :loading="desktop.busy" @click="restart">Restart server</UButton></template
        >
      </UModal>
    </UTheme></UApp
  >
</template>
