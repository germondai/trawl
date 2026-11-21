<script setup lang="ts">
import { useNavigationModal } from "~/composables/useNavigationSteps"
import { t } from "~/utils/localization"
import { type Page, pages } from "~/utils/page-history"

const { page } = defineProps<{ page: Page }>()
const emit = defineEmits<{ navigate: [page: Page]; request: [] }>()
const menu = shallowRef<"tools" | "settings">()
useNavigationModal(menu, undefined, true)
const tools = pages.filter((item) => ["sessions", "browser", "resources", "logs"].includes(item.id))
const settings = pages.filter((item) => item.group === "Manage")
const items = computed(() => (menu.value === "tools" ? tools : settings))
function visit(next: Page) {
  menu.value = undefined
  emit("navigate", next)
}
</script>

<template>
  <nav class="mobile-navigation" data-tour="navigation" :aria-label="t('ui.mainNavigation')">
    <UButton
      icon="i-lucide-activity"
      :label="t('ui.overview')"
      color="neutral"
      variant="ghost"
      :class="{ selected: page === 'overview' }"
      :aria-current="page === 'overview' ? 'page' : undefined"
      @click="emit('navigate', 'overview')"
    />
    <UButton
      icon="i-lucide-network"
      :label="t('ui.requests')"
      color="neutral"
      variant="ghost"
      :class="{ selected: page === 'history' }"
      :aria-current="page === 'history' ? 'page' : undefined"
      @click="emit('navigate', 'history')"
    />
    <UButton
      icon="i-lucide-plus"
      class="mobile-request"
      data-tour="new-request"
      :aria-label="t('ui.newRequest')"
      @click="emit('request')"
    />
    <UButton
      icon="i-lucide-gauge"
      :label="t('ui.tools')"
      color="neutral"
      variant="ghost"
      :class="{ selected: tools.some((item) => item.id === page) }"
      :aria-expanded="menu === 'tools'"
      @click="menu = 'tools'"
    />
    <UButton
      icon="i-lucide-settings"
      :label="t('ui.settings')"
      color="neutral"
      variant="ghost"
      :class="{ selected: settings.some((item) => item.id === page) }"
      :aria-expanded="menu === 'settings'"
      @click="menu = 'settings'"
    />
  </nav>
  <AppDialog
    :open="!!menu"
    :title="menu === 'tools' ? t('ui.tools') : t('ui.settings')"
    :ui="{ content: 'mobile-navigation-menu' }"
    @update:open="
      (value) => {
        if (!value) menu = undefined
      }
    "
  >
    <template #body>
      <div class="mobile-menu-items">
        <UButton
          v-for="item in items"
          :key="item.id"
          :icon="item.icon"
          :label="item.label"
          color="neutral"
          variant="ghost"
          :aria-current="item.id === page ? 'page' : undefined"
          @click="visit(item.id)"
        />
      </div>
    </template>
  </AppDialog>
</template>
