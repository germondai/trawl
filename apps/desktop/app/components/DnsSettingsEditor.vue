<script setup lang="ts">
import { dnsProviders } from "@trawl/config/catalog"
import { useNavigationModal } from "~/composables/useNavigationSteps"
import { t } from "~/utils/localization"
import type { DnsSelection } from "~/utils/settings"

const { resolver, servers, disabled, focusServers } = defineProps<{
  resolver: string
  servers: string
  disabled?: boolean
  focusServers?: number
}>()
const emit = defineEmits<{ change: [selection: DnsSelection] }>()
const open = shallowRef(false)
useNavigationModal(open, false)
const selected = shallowRef("system")
const addresses = ref<{ id: number; value: string }[]>([])
let nextAddress = 0
function addServer(value = "") {
  addresses.value.push({ id: ++nextAddress, value })
}
const choices = [
  {
    get label() {
      return t("ui.systemDns")
    },
    value: "system",
  },
  ...Object.entries(dnsProviders).map(([value, provider]) => ({ value, label: `${provider.label} (HTTPS)` })),
  {
    get label() {
      return t("ui.customServers")
    },
    value: "custom",
  },
]
const label = computed(() => choices.find(({ value }) => value === resolver)?.label ?? resolver)
const provider = computed(() => dnsProviders[selected.value as keyof typeof dnsProviders])
const valid = computed(() => selected.value !== "custom" || addresses.value.some(({ value }) => value.trim()))
function edit() {
  selected.value = resolver
  addresses.value = []
  for (const value of servers
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean))
    addServer(value)
  if (!addresses.value.length) addServer()
  open.value = true
}
function apply() {
  if (!valid.value) return
  const values =
    selected.value === "custom"
      ? addresses.value
          .map(({ value }) => value.trim())
          .filter(Boolean)
          .join(",")
      : ""
  emit("change", { resolver: selected.value, servers: values })
  open.value = false
}
watch(
  () => focusServers,
  (revision) => {
    if (!revision) return
    edit()
    selected.value = "custom"
  },
  { immediate: true },
)
</script>
<template>
  <UButton
    icon="i-lucide-network"
    color="neutral"
    variant="outline"
    class="settings-editor-button"
    :disabled="disabled"
    :aria-label="t('ui.manageInstanceDns', { p0: label })"
    @click="edit"
    >{{
      label
    }}</UButton
  >
  <AppDialog
    v-model:open="open"
    :title="t('ui.instanceDns')"
    :description="t('ui.chooseHowThisInstanceResolvesWebsiteAddressesDevice')"
  >
    <template #body>
      <div class="dns-editor-fields">
        <UFormField :label="t('ui.resolver')">
          <USelect
            v-model="selected"
            :items="choices"
            class="w-full"
            :aria-label="t('ui.dnsResolver')"
            :disabled="disabled"
          />
        </UFormField>
        <p v-if="selected !== 'system' && selected !== 'custom'" class="muted text-sm">
          {{ t("ui.httpsEncryptsDnsQueriesToThisResolverBoth") }}
        </p>
        <template v-if="provider">
          <UFormField :label="t('ui.dnsOverHttpsEndpoint')">
            <UInput
              :model-value="provider.url"
              readonly
              disabled
              class="w-full"
              :aria-label="t('ui.dnsOverHttpsEndpoint')"
            />
          </UFormField>
          <UFormField
            :label="t('ui.bootstrapIpAddress')"
            :description="t('ui.usedToReachThisResolverWithoutAskingDevice')"
          >
            <UInput
              :model-value="provider.bootstrap"
              readonly
              disabled
              class="w-full"
              :aria-label="t('ui.bootstrapIpAddress')"
            />
          </UFormField>
        </template>
        <p v-else-if="selected === 'system'" class="muted text-sm">
          {{ t("ui.usesTheOperatingSystemSCurrentResolverTrawl") }}
        </p>
        <template v-if="selected === 'custom'">
          <p class="muted text-sm">
            {{ t("ui.addUpToFourServersInPriorityOrder") }}
          </p>
          <DnsServerField
            v-for="(server, index) in addresses"
            :key="server.id"
            v-model="server.value"
            :position="index + 1"
            :field-id="`dns-address-${server.id}`"
            :disabled="disabled"
            :removable="addresses.length > 1"
            @remove="addresses = addresses.filter((row) => row.id !== server.id)"
          />
          <UButton
            icon="i-lucide-plus"
            color="neutral"
            variant="outline"
            class="justify-self-start"
            :disabled="disabled || addresses.length >= 4"
            @click="addServer()"
            >{{
              t("ui.addServer")
            }}</UButton
          >
          <p class="muted text-xs">{{ t("ui.anOptionalPortIsSupported100") }}</p>
        </template>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="ghost" @click="open = false">{{ t("ui.cancel") }}</UButton>
      <UButton :disabled="disabled || !valid" @click="apply">{{ t("ui.done") }}</UButton>
    </template>
  </AppDialog>
</template>
