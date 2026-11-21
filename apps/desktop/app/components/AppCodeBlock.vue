<script setup lang="ts">
defineProps<{ code: string; language?: string }>()
</script>
<template>
  <figure class="app-code-block">
    <figcaption v-if="language" class="mono muted">{{ language }}</figcaption>
    <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users can scroll long source. -->
    <pre class="mono" tabindex="0"><code>{{ code }}</code></pre>
  </figure>
</template>
<style scoped>
.app-code-block {
  margin: 0;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--ui-bg);
}
.app-code-block figcaption {
  padding: 8px 16px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 11px;
}
.app-code-block pre {
  margin: 0;
  padding: 16px;
  max-height: min(480px, 60dvh);
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.7;
}
</style>
