<script setup lang="ts">
import { type BrowserTag, type BrowserTagDefinition, browserTags } from "~/utils/browser-tags"

const { tag } = defineProps<{ tag: BrowserTag }>()
const badge = computed<BrowserTagDefinition>(() => browserTags[tag])
</script>

<template>
  <UTooltip :text="badge.description">
    <UBadge :color="badge.color" :variant="badge.variant" :class="badge.class" size="sm">{{ badge.label }}</UBadge>
  </UTooltip>
</template>
