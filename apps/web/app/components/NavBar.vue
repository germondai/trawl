<script lang="ts" setup>
const docsUrl = useDocsUrl()
const stars = useGithubStars()
const menuOpen = ref(false)

function closeMenu() {
  menuOpen.value = false
}
</script>

<template>
  <header class="navbar">
    <div class="navbar-inner">
      <a href="/" class="brand" @click="closeMenu">
        <span class="brand-mark">TRAWL</span>
        <span class="brand-dot" />
      </a>

      <nav class="nav-links">
        <a href="#features" class="nav-link">features</a>
        <a href="#captcha" class="nav-link">captcha</a>
        <a href="#how-it-works" class="nav-link">tiers</a>
        <a href="#compare" class="nav-link">benchmarks</a>
        <a href="#code" class="nav-link">quickstart</a>
        <a :href="docsUrl" class="nav-link">docs</a>
        <a
          href="https://github.com/germondai/trawl"
          target="_blank"
          rel="noopener"
          class="nav-link nav-github"
          title="GitHub"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path
              d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
            />
          </svg>
          <span v-if="stars" class="nav-github-stars">{{ stars }}</span>
        </a>
      </nav>

      <div class="nav-right">
        <a href="#code" class="btn btn-primary nav-cta">get started</a>
        <button
          type="button"
          class="burger"
          :class="{ open: menuOpen }"
          @click="menuOpen = !menuOpen"
          aria-label="Toggle menu"
        >
          <span /><span /><span />
        </button>
      </div>
    </div>

    <!-- Mobile menu -->
    <Transition name="menu">
      <div v-if="menuOpen" class="mobile-menu">
        <a href="#features" class="mobile-link" @click="closeMenu">features</a>
        <a href="#captcha" class="mobile-link" @click="closeMenu">captcha</a>
        <a href="#how-it-works" class="mobile-link" @click="closeMenu">tiers</a>
        <a href="#compare" class="mobile-link" @click="closeMenu">benchmarks</a>
        <a href="#code" class="mobile-link" @click="closeMenu">quickstart</a>
        <a :href="docsUrl" role="link" class="mobile-link" @click="closeMenu" @keydown.enter="closeMenu">docs</a>
        <a
          href="https://github.com/germondai/trawl"
          target="_blank"
          rel="noopener"
          class="mobile-link mobile-github"
          @click="closeMenu"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path
              d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
            />
          </svg>
          GitHub
          <span v-if="stars" class="mobile-github-stars">★ {{ stars }}</span>
        </a>
      </div>
    </Transition>
  </header>

  <!-- Click-outside backdrop -->
  <Teleport to="body">
    <div v-if="menuOpen" class="menu-backdrop" aria-hidden="true" @click="closeMenu" />
  </Teleport>
</template>

<style scoped>
.navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}

.navbar-inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 24px;
  height: 60px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 32px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand-mark {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--text);
}

.brand-dot {
  width: 5px;
  height: 5px;
  background: var(--accent);
  animation: pulse-dot 2.5s ease-in-out infinite;
}

.nav-links {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
}

.nav-link {
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
  transition: color 0.12s;
  white-space: nowrap;
}
.nav-link:hover {
  color: var(--accent);
}

.nav-github {
  display: flex;
  align-items: center;
  gap: 5px;
  line-height: 1;
}

.nav-github-stars {
  font-size: 11px;
  color: var(--text-muted);
}

.mobile-github-stars {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
}

.nav-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.nav-cta {
  font-size: 11px;
  padding: 8px 16px;
}

/* Burger button — hidden on desktop */
.burger {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 32px;
  height: 32px;
  padding: 6px;
  background: none;
  border: 1px solid var(--border);
  cursor: pointer;
}

.burger span {
  display: block;
  height: 1px;
  background: var(--text-muted);
  transition: all 0.2s;
  transform-origin: center;
}

.burger.open span:nth-child(1) {
  transform: translateY(6px) rotate(45deg);
}
.burger.open span:nth-child(2) {
  opacity: 0;
}
.burger.open span:nth-child(3) {
  transform: translateY(-6px) rotate(-45deg);
}

/* Mobile menu drawer */
.mobile-menu {
  border-top: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  flex-direction: column;
}

.mobile-link {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  font-size: 13px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
  transition:
    color 0.12s,
    background 0.12s;
}
.mobile-link:hover {
  color: var(--accent);
  background: var(--bg-subtle);
}

.mobile-github {
  border-top: 1px solid var(--border);
}

/* Click-outside backdrop — below navbar (z:100), above page content */
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 99;
}

/* Slide transition */
.menu-enter-active,
.menu-leave-active {
  transition:
    opacity 0.15s,
    transform 0.15s;
}
.menu-enter-from,
.menu-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@keyframes pulse-dot {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.85);
  }
}

@media (max-width: 900px) {
  .nav-links {
    gap: 16px;
  }
  .nav-links .nav-link:not(.nav-github):nth-child(n + 5) {
    display: none;
  }
}

@media (max-width: 640px) {
  /* 2-column grid: brand (auto) | nav-right (1fr, end-aligned).
     nav-links is display:none so it's removed from grid placement. */
  .navbar-inner {
    grid-template-columns: auto 1fr;
    padding: 0 16px;
    gap: 12px;
  }
  .nav-links {
    display: none;
  }
  .nav-right {
    justify-self: end;
  }
  .nav-cta {
    font-size: 10px;
    padding: 6px 12px;
  }
  .burger {
    display: flex;
  }
  .mobile-link {
    padding: 12px 16px;
  }
}
</style>
