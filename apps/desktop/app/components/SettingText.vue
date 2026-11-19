<script setup lang="ts">
import { settings } from "@trawl/config/catalog"

const props = defineProps<{ text: string }>()
const names = new Set(settings.map(({ name }) => name))
const parts = computed(() => props.text.split(/(\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b)/g))
</script>
<template
  ><template v-for="(part, index) in parts" :key="index"
    ><SettingLink v-if="names.has(part)" :name="part" /><template v-else>{{ part }}</template></template
  ></template
>
