<script setup lang="ts">
import { settingNavigation } from "~/utils/setting-navigation"

defineProps<{ name: string }>()
const navigate = inject(settingNavigation)
</script>
<template
  ><button type="button" class="setting-link" @click="navigate?.(name)"><slot>{{ name }}</slot></button></template
>
