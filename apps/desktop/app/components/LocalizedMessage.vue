<script setup lang="ts">
import { tTemplate } from "~/utils/localization"

const props = defineProps<{ message: string; parameters?: Record<string, string | number> }>()
const parts = computed(() =>
  tTemplate(props.message, Number(props.parameters?.count ?? 0)).split(/(\{[a-zA-Z][a-zA-Z0-9_]*\})/g),
)
const name = (part: string) => (/^\{[a-zA-Z][a-zA-Z0-9_]*\}$/.test(part) ? part.slice(1, -1) : undefined)
</script>
<template>
  <template v-for="(part, index) in parts" :key="index">
    <slot v-if="name(part)" :name="name(part)!">{{ parameters?.[name(part)!] ?? part }}</slot>
    <template v-else>{{ part }}</template>
  </template>
</template>
