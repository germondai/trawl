<script lang="ts" setup>
const colorMode = useColorMode()
const showScrollTop = shallowRef(false)

function toggleTheme() {
  colorMode.preference = colorMode.value === "dark" ? "light" : "dark"
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" })
}

function onScroll() {
  showScrollTop.value = window.scrollY > 400
}

onMounted(() => window.addEventListener("scroll", onScroll, { passive: true }))
onUnmounted(() => window.removeEventListener("scroll", onScroll))
</script>

<template>
  <button
    type="button"
    class="float-btn float-theme"
    :class="{ raised: showScrollTop }"
    :title="colorMode.value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
    @click="toggleTheme"
  >
    <span v-if="colorMode.value === 'dark'">☀</span>
    <span v-else>◐</span>
  </button>

  <Transition name="slide-up">
    <button
      type="button"
      v-if="showScrollTop"
      class="float-btn float-scroll"
      title="Scroll to top"
      @click="scrollToTop"
    >
      ↑
    </button>
  </Transition>
</template>

<style scoped>
.float-btn {
  position: fixed;
  right: 24px;
  z-index: 200;
  width: 36px;
  height: 36px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-family: inherit;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.float-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.float-theme {
  bottom: 24px;
  transition:
    bottom 0.2s ease,
    border-color 0.12s,
    color 0.12s;
}
.float-theme.raised {
  bottom: 68px; /* 24px base + 36px btn + 8px gap */
}

.float-scroll {
  bottom: 24px;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
