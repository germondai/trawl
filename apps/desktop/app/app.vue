<script setup lang="ts">
import { cs, de, en, fr, pl, sk } from "@nuxt/ui/locale"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { type ShortcutAction, shortcutDefinitions } from "@trawl/config/catalog"
import { confirmationContent, provideNavigationSteps, useBrowserNavigation } from "~/composables/useNavigationSteps"
import { eventShortcut } from "~/utils/keybindings"
import { appLocale, nativeErrorMessage, t } from "~/utils/localization"
import { type HistoryGesturePhase, installNativeHistoryGesture } from "~/utils/native-history-gesture"
import { cyclePage, type Page } from "~/utils/page-history"
import { type SettingTarget, settingNavigation } from "~/utils/setting-navigation"
import { newWorkbenchDraft, replacesWorkbenchDraft } from "~/utils/workbench"

const desktop = useDesktopStore()
const feedback = useInteractionFeedback()
useInteractionAudioActivation()
useScrollEdgeFeedback()
const initializing = shallowRef(desktop.native)
let initialized = false
const appUpdates = useAppUpdates()
onMounted(() => {
  void appUpdates.start().catch(() => {})
})
watch(
  () => appUpdates.result.value?.version,
  (version) => {
    if (version && appUpdates.result.value?.state === "available")
      useToast().add({
        title: t("ui.trawlIsAvailable", { p0: version }),
        description: t("ui.installItFromAppSettings"),
        actions: [{ label: t("ui.appSettings"), onClick: () => navigate("connections") }],
      })
  },
)
const downloads = useBrowserDownloadsStore()
const macOS = /Mac/.test(navigator.platform)
const nativeMac = desktop.native && macOS
const nativeWindows = desktop.native && /^Win/.test(navigator.platform)
const nativeShortcuts = nativeMac || desktop.mobile
let historyGesture: ReturnType<typeof installNativeHistoryGesture> | undefined
let historyPhase: UnlistenFn | undefined
onMounted(async () => {
  if (!desktop.native || desktop.mobile) return
  historyGesture = installNativeHistoryGesture({
    enabled: () => !phone.value && !document.querySelector('[role="dialog"],[data-shortcut-recording]'),
    canNavigate: (direction) => (direction === "back" ? canBack.value : canForward.value),
    preview: nativeMac ? previewHistory : undefined,
    onThreshold: nativeMac ? () => feedback("gesture", false) : undefined,
    navigate: (direction) => {
      if (nativeMac) previewHistory(direction, 0, true)
      move(direction === "back" ? -1 : 1, nativeMac)
    },
  })
  if (nativeMac)
    historyPhase = await listen<HistoryGesturePhase>("trawl:history-gesture-phase", ({ payload }) =>
      historyGesture?.phase(payload),
    )
})
onBeforeUnmount(() => {
  historyGesture?.dispose()
  historyPhase?.()
})
const kbds = useShortcutKeys()
const quitKeys = computed(() => kbds("quit"))
const navigation = provideNavigationSteps()
usePopupNavigation(navigation, (open) => feedback(open ? "open" : "close"))
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
function move(direction: -1 | 1, trackpad = false) {
  const next = navigation.peek(direction)
  if (next) moveTo(next.id, trackpad)
}
function moveTo(id: number, trackpad = false) {
  const next = navigation.find(id)
  if (!next) return
  const apply = () => {
    const before = navigation.current.value
    if (before.id === id) return
    const changedPage = next.page !== before.page
    if (nativeMac && !trackpad && changedPage) feedback("gesture")
    navigation.go(id)
    if (changedPage && (!nativeMac || trackpad)) feedback("navigate", true, !trackpad)
  }
  if (next.page !== page.value) guard(apply)
  else apply()
}
useBrowserNavigation(navigation, moveTo)
const sidebarOpen = shallowRef(false)
watch(sidebarOpen, (open) => feedback(open ? "sidebar-open" : "sidebar-close"))
const sidebarCollapsed = shallowRef(false)
watch(sidebarCollapsed, (collapsed) => feedback(collapsed ? "sidebar-close" : "sidebar-open"))
const sidebarHidden = computed(
  () => sidebarCollapsed.value && desktop.config.desktop.sidebarBehavior === "hide" && !onboardingOpen.value,
)
const { television, phone } = useAppLayout()
const sidebarMode = computed(() => (sidebarHidden.value ? "hidden" : sidebarCollapsed.value ? "icons" : "expanded"))
useHead(() => ({ htmlAttrs: { "data-layout": television ? "television" : phone.value ? "phone" : "desktop" } }))
const { dismiss: dismissTooltips } = useTooltipLifecycle()
onScopeDispose(navigation.subscribe(dismissTooltips))
const onboardingOpen = shallowRef(false)
function openTour() {
  guard(() => {
    onboardingOpen.value = true
  })
}
const commandsOpen = shallowRef(false)
function openCommands() {
  sidebarOpen.value = false
  commandsOpen.value = true
}
useEventListener(window, "resize", () => {
  if (window.matchMedia("(min-width: 1024px)").matches) sidebarOpen.value = false
})
const settingTarget = shallowRef<SettingTarget>()
const connectionFocus = shallowRef(0)
const findOpen = shallowRef(false)
const pageFinder = useTemplateRef("pageFinder")
watch(page, () => {
  findOpen.value = false
})
function openConnections() {
  guard(() => {
    connectionFocus.value++
    navigation.visit("connections")
  })
}
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
  if (phone.value) openCommands()
  else sidebarCollapsed.value = !sidebarCollapsed.value
}
useEventListener(
  document,
  "pointerdown",
  (event: PointerEvent) => {
    const target = event.target as Element | null
    if (target?.closest('input, textarea, [contenteditable="true"]')) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const inside = [...selection.getRangeAt(0).getClientRects()].some(
      (rect) =>
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom,
    )
    if (!inside) selection.removeAllRanges()
  },
  { capture: true },
)
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
    if (!phone.value && (event.metaKey || event.ctrlKey) && !event.altKey && event.code === "KeyF") {
      event.preventDefault()
      findOpen.value = true
      nextTick(() => pageFinder.value?.focus())
      return
    }
    if (event.key === "Escape" && findOpen.value) {
      event.preventDefault()
      findOpen.value = false
      return
    }
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
const previewHistory = usePredictiveBack({
  enabled: desktop.mobile || nativeMac,
  android: desktop.mobile,
  animate: () =>
    (nativeMac || phone.value) && !initializing.value && !desktop.settingsDirty && !document.fullscreenElement,
  workspace: () => workspacePane.value,
  current: () => navigation.current.value,
  destination: (direction) => navigation.peek(direction === "back" ? -1 : 1),
  navigate: () => move(-1),
})
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
async function refreshPage() {
  if (!desktop.native || desktop.busy) return
  await pageRefresh.refresh().catch((cause) => {
    useToast().add({ title: t("ui.couldNotRefreshPage"), description: nativeErrorMessage(cause), color: "error" })
  })
}
const pullRefresh = usePullRefresh(
  workspaceScroll,
  () =>
    phone.value &&
    desktop.native &&
    !desktop.busy &&
    !pageRefresh.busy.value &&
    !document.querySelector('[role="dialog"]'),
  refreshPage,
)
watch(page, pullRefresh.reset)
useTypeToFocus(workspaceScroll)
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
useNativeShell(sidebarOpen, initializing)
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
  navigation.bindModal(sidebarOpen, false, true),
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
    if ((workspaceScroll.value?.scrollTop ?? 0) > 0) scrollToTop()
    feedback("active")
    sidebarOpen.value = false
    return
  }
  guard(() => {
    navigation.visit(next, next === "workbench" ? { "workbench-tab": workbench.activeTabId } : {})
    feedback("navigate")
    sidebarOpen.value = false
  })
}
function addRequestTab() {
  if (workbench.addTab()) return true
  useToast().add({
    title: t("ui.eightRequestTabsAreAlreadyOpen"),
    description: t("ui.closeATabBeforeCreatingAnotherRequest"),
    color: "neutral",
  })
  return false
}
function tourNavigate(next: Page, step: string) {
  navigation.visit(next, { "app-tour-step": step }, { preserveModals: true })
  sidebarOpen.value = false
}
function newRequest() {
  guard(() => {
    if (replacesWorkbenchDraft(workbench.draft, newWorkbenchDraft())) addRequestTab()
    navigation.visit("workbench", { "workbench-tab": workbench.activeTabId })
    feedback("navigate")
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
  await desktop.start(true)
}
const remember = shallowRef(true)
const visible = useDocumentVisibility()
let resumeGeneration = 0
let disposed = false
const unlisteners: UnlistenFn[] = []
const { pause, resume } = useIntervalFn(
  () => {
    void desktop.refresh()
  },
  5000,
  { immediate: false },
)
async function foreground() {
  const generation = ++resumeGeneration
  if (!initialized) return
  if (desktop.mobile) {
    initializing.value = true
    await desktop.refresh(true)
    if (generation !== resumeGeneration || disposed || visible.value !== "visible") return
    initializing.value = false
  } else void desktop.refresh()
  resume()
}
function background() {
  pause()
  if (desktop.mobile) {
    resumeGeneration++
    initializing.value = true
  }
}
useEventListener(window, "trawl-background", background)
useEventListener(window, "trawl-foreground", foreground)
watch(visible, (state) => (state === "visible" ? foreground() : background()))
onMounted(async () => {
  if (!desktop.native) return
  const startupGeneration = resumeGeneration
  try {
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
    await desktop.bootstrap()
    await desktop.refresh(true)
    if (!disposed) {
      const instance = await invoke<string>("tray_instance", { id: null })
      if (instance !== desktop.activeId) await desktop.select(instance)
      await takeInstanceRequest()
    }
    if (!disposed) await takePageRequest()
    if (!disposed && visible.value === "visible") resume()
  } catch (cause) {
    if (!disposed) desktop.setError(cause)
  } finally {
    await document.fonts.ready
    initialized = true
    // Desktop windows start hidden and can only be shown after initialization finishes.
    if (!disposed && (!desktop.mobile || visible.value === "visible")) {
      if (desktop.mobile && startupGeneration !== resumeGeneration) await foreground()
      else initializing.value = false
    }
  }
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
  <UApp :locale="{ en, cs, sk, pl, de, fr }[appLocale]"
    ><UTheme :props="{ modal: { transition: false } }">
      <UDashboardGroup
        unit="rem"
        storage="local"
        storage-key="trawl-desktop"
        class="desktop-shell"
        :data-initializing="initializing"
        :aria-busy="initializing"
        data-native-window-chrome
        :class="{
          'native-mac': nativeMac,
          'native-windows-shell': nativeWindows,
          'phone-layout': phone,
          'television-layout': television,
          'sidebar-fully-hidden': sidebarHidden,
        }"
      >
        <ShellSidebar
          v-if="!phone"
          v-model:open="sidebarOpen"
          v-model:collapsed="sidebarCollapsed"
          :hidden="sidebarHidden"
          :page="page"
          @navigate="(next) => (next === 'workbench' && page !== 'workbench' ? newRequest() : navigate(next))"
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
                :phone="phone"
                :sidebar-mode="sidebarMode"
                :refreshing="pageRefresh.busy.value"
                :page="page"
                :can-back="canBack"
                :can-forward="canForward"
                :native-mac="nativeMac"
                @back="move(-1)"
                @forward="move(1)"
                @restart="restartPrompt = true"
                @refresh="refreshPage"
                @sidebar="toggleSidebar"
                @search="openCommands"
              />
              <PageFind v-if="!phone" ref="pageFinder" v-model="findOpen" :root="workspaceScroll" />
              <PullRefreshIndicator
                v-if="phone"
                :distance="pullRefresh.distance.value"
                :refreshing="pullRefresh.refreshing.value"
              />
              <div
                ref="workspaceScroll"
                class="workspace-scroll"
                :class="{
                  'workspace-fill':
                    page === 'logs' ||
                    ((page === 'overview' || page === 'history') &&
                      desktop.activeId === 'local' &&
                      !desktop.status.running),
                }"
              >
                <div class="content">
                  <div v-if="!desktop.native" class="notice">
                    {{ t("ui.desktopPreviewOpenTheNativeApplicationToManage") }}
                  </div>
                  <div v-if="desktop.error" class="notice error" role="alert">{{ desktop.error }}</div>
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
                        {{ t("ui.androidSystemWebviewUsesAFreshPageFor") }}
                      </div>
                      <SessionManager
                        v-else-if="page === 'sessions'"
                        @use="
                          useWorkbenchStore().draft.sessionId = $event;
                          navigate('workbench');
                        "
                      />
                      <template v-else-if="page === 'resources'"><ResourceUsage @navigate="navigate" /></template>
                      <template v-else-if="page === 'browser'"
                        ><BrowserInspector
                          v-if="!desktop.mobile || desktop.activeId !== 'local'"
                          @workbench="navigate('workbench')"
                          @history="
                            openRequestId = $event;
                            navigate('history');
                          "
                        />
                        <BrowserManager v-if="desktop.activeId === 'local'" @connect="openConnections" />
                        <div v-else class="notice">
                          {{ t("ui.browserInstallationsAreManagedOnTheirHostSelect") }}
                        </div></template
                      >
                      <template v-else-if="page === 'settings'"
                        ><ServerSettings
                          v-if="desktop.activeId === 'local' && (!desktop.native || desktop.loaded)"
                          :focus-setting="settingTarget"
                          @focused="settingTarget = undefined"
                        />
                        <div v-else-if="desktop.activeId === 'local'" class="notice">
                          {{ t("ui.localConfigurationIsNotLoadedYet") }}
                          <UButton
                            color="neutral"
                            variant="link"
                            :loading="desktop.busy"
                            @click="desktop.action(() => desktop.bootstrap())"
                            >{{
                              t("ui.loadConfiguration")
                            }}</UButton
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
                        ><ConnectionSettings
                          v-if="!desktop.native || desktop.loaded"
                          :focus-connections="connectionFocus"
                          @onboarding="openTour"
                        />
                        <div v-else class="notice">
                          {{ t("ui.loadTheLocalConfigurationBeforeEditingConnections") }}
                          <UButton
                            color="neutral"
                            variant="link"
                            :loading="desktop.busy"
                            @click="desktop.action(() => desktop.bootstrap())"
                            >{{
                              t("ui.loadConfiguration")
                            }}</UButton
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
                <div v-if="!phone && page !== 'workbench'" key="request">
                  <AppTooltip :text="t('ui.newRequest')" :kbds="kbds('workbench')"
                    ><UButton
                      class="new-request-fab"
                      icon="i-lucide-plus"
                      :aria-label="t('ui.newRequest')"
                      data-tour="new-request"
                      @click="newRequest"
                    /></AppTooltip
                  >
                </div>
              </TransitionGroup>
              <MobileNavigation v-if="phone" :page="page" @navigate="navigate" @request="newRequest" />
            </section>
          </UTheme>
        </main>
      </UDashboardGroup>
      <AppOnboarding v-model:open="onboardingOpen" :ready="!initializing" @navigate="tourNavigate" />
      <ShellCommands
        v-model:open="commandsOpen"
        :page="page"
        @action="runShortcut"
        @navigate="navigate"
        @onboarding="openTour"
        @setting="openSetting"
        @select="selectInstance"
      />
      <div v-if="quitFeedback" class="quit-hold" role="status">
        <UIcon name="i-lucide-power" class="size-5" />
        <span class="quit-message"
          ><LocalizedMessage
            :message="quitFeedback === 'double' ? 'quit.pressAgain' : quitArmed ? 'quit.release' : 'quit.hold'"
          >
            <template #keys
              ><span class="inline-flex items-center gap-1"
                ><UKbd v-for="key in quitKeys" :key="key" :value="key" /></span
              ></template
            >
          </LocalizedMessage>
        </span>
        <span v-if="quitFeedback === 'hold'" class="quit-progress" aria-hidden="true" />
      </div>
      <AppDialog
        v-model:open="closePrompt"
        :content="confirmationContent"
        :title="t('ui.keepTrawlRunning')"
        :description="t('ui.chooseWhatHappensWhenYouCloseTheWindow')"
        :dismissible="false"
        ><template #body
          ><p>
            {{ t("ui.keepingTrawlRunningLeavesTheLocalServerAvailable") }}
          </p>
          <USwitch
            v-model="remember"
            :label="t('ui.rememberMyChoice')"
            :disabled="!desktop.loaded || desktop.busy"
            class="mt-6"
          />
          <p v-if="!desktop.loaded" class="mt-2 text-sm">
            {{ t("ui.preferencesAreStillLoadingThisChoiceWillApply") }}
          </p></template
        ><template #footer
          ><div class="actions">
            <UButton color="neutral" variant="ghost" @click="closePrompt = false">{{ t("ui.cancel") }}</UButton
            ><UButton color="neutral" variant="outline" @click="close('quit', true)">{{
              t("ui.quitCompletely")
            }}</UButton><UButton data-confirm-default @click="close('tray', true)">{{ t("ui.keepRunning") }}</UButton>
          </div></template
        ></AppDialog
      >
      <AppDialog
        :open="Boolean(pendingAction)"
        :content="confirmationContent"
        :title="t('ui.discardUnsavedSettings')"
        :description="t('ui.yourChangesHaveNotBeenSaved')"
        @update:open="if (!$event) pendingAction = null;"
      >
        <template #footer
          ><UButton color="neutral" variant="outline" @click="pendingAction = null">{{ t("ui.keepEditing") }}</UButton
          ><UButton data-confirm-default @click="acceptDiscard">{{ t("ui.discardChanges") }}</UButton></template
        >
      </AppDialog>
      <AppDialog
        v-model:open="restartPrompt"
        :content="confirmationContent"
        :title="t('ui.restartTheLocalServer')"
        :description="t('ui.theServerWillStopAcceptingRequestsWhileIt')"
      >
        <template #footer
          ><UButton color="neutral" variant="outline" @click="restartPrompt = false">{{ t("ui.cancel") }}</UButton
          ><UButton data-confirm-default :loading="desktop.busy" @click="restart">{{
            t("ui.restartServer")
          }}</UButton></template
        >
      </AppDialog>
    </UTheme></UApp
  >
</template>
