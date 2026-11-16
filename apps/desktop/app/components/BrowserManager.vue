<script setup lang="ts">
const desktop = useDesktopStore()
const confirm = shallowRef<"repair" | "uninstall" | null>(null)
const state = computed(() => desktop.browser.state ?? (desktop.browser.installed ? "ready" : "not-installed"))
const labels = {
  ready: "Ready",
  "not-installed": "Not installed",
  "repair-needed": "Needs repair",
  "update-available": "Compatible version needed",
  unsupported: "Unsupported platform",
}
const changeAllowed = computed(() => desktop.native && !desktop.busy && !desktop.status.running)
const hasInstallation = computed(() => !["not-installed", "unsupported"].includes(state.value))
const downloadSize = computed(() =>
  desktop.browser.downloadBytes ? `${Math.ceil(desktop.browser.downloadBytes / 1048576)} MiB` : "300 to 700 MB",
)
async function change() {
  const operation = confirm.value
  confirm.value = null
  await desktop.action(() =>
    desktop.management({ action: operation === "repair" ? "repairBrowser" : "uninstallBrowser" }),
  )
}
</script>
<template>
  <div class="section-intro">
    <h2>Browser installation</h2>
    <p>
      TRAWL manages a compatible Camoufox browser on this device. Your settings and request history stay separate from
      the browser installation.
    </p>
  </div>
  <div v-if="desktop.status.running" class="notice">
    Stop the local server before repairing, upgrading or removing its browser.
  </div>
  <div class="panel">
    <div class="panel-heading">
      <div class="browser-heading">
        <UIcon name="i-lucide-globe" class="size-5" />
        <h2>Camoufox Firefox</h2>
      </div>
      <span class="status"><span class="dot" :class="{ ready: desktop.browser.installed }" />{{ labels[state] }}</span>
    </div>
    <dl class="browser-details">
      <div>
        <dt>Installed version</dt>
        <dd class="mono">{{ desktop.browser.version ?? "Not installed" }}</dd>
      </div>
      <div>
        <dt>Supported by this build</dt>
        <dd class="mono">{{ desktop.browser.supportedVersion ?? "Pinned by TRAWL" }}</dd>
      </div>
      <div>
        <dt>Browser download</dt>
        <dd>{{ downloadSize }}<span class="muted"> · internet required for setup</span></dd>
      </div>
      <div>
        <dt>Install location</dt>
        <dd class="mono">{{ desktop.browser.path ?? "Private TRAWL data directory" }}</dd>
      </div>
    </dl>
    <div class="browser-actions">
      <UButton
        v-if="!desktop.browser.installed && state !== 'unsupported'"
        icon="i-lucide-download"
        :disabled="!changeAllowed"
        :loading="desktop.busy"
        @click="desktop.install"
        >{{
          state === "update-available"
            ? "Install compatible version"
            : state === "repair-needed"
              ? "Repair browser"
              : "Install browser"
        }}</UButton
      >
      <UButton
        v-if="desktop.browser.installed"
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="outline"
        :disabled="!changeAllowed"
        @click="confirm = 'repair'"
        >Repair installation</UButton
      >
      <UButton
        v-if="hasInstallation"
        icon="i-lucide-trash-2"
        color="neutral"
        variant="ghost"
        :disabled="!changeAllowed"
        @click="confirm = 'uninstall'"
        >Uninstall browser</UButton
      >
    </div>
  </div>
  <div class="browser-note">
    <UIcon name="i-lucide-circle-check" class="size-4 shrink-0" />
    <p>
      Downloads are pinned and checked before activation. Repair and upgrade keep the previous installation until the
      replacement is ready. Browser upgrades are shipped with compatible TRAWL builds.
    </p>
  </div>
  <UModal
    :open="confirm !== null"
    :title="confirm === 'uninstall' ? 'Uninstall the browser?' : 'Repair the browser?'"
    :description="
      confirm === 'uninstall'
        ? 'This removes the managed browser, its add-ons and GeoIP data. Server settings and request history are kept. You will need to install the browser again before starting TRAWL.'
        : 'Download and verify a fresh copy of the supported browser. The current installation stays available until the replacement is ready.'
    "
    @update:open="if (!$event) confirm = null;"
  >
    <template #footer
      ><UButton variant="outline" color="neutral" @click="confirm = null">Cancel</UButton
      ><UButton :color="confirm === 'uninstall' ? 'error' : 'primary'" :disabled="!changeAllowed" @click="change">{{
        confirm === "uninstall" ? "Uninstall browser" : "Repair browser"
      }}</UButton></template
    >
  </UModal>
</template>
