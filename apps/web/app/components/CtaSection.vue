<script lang="ts" setup>
const docsUrl = useDocsUrl()

type Tab = "docker" | "minimal" | "cached" | "production"
const active = shallowRef<Tab>("minimal")

const tabs: { id: Tab; label: string; hint: string }[] = [
  { id: "docker", label: "docker run", hint: "single command" },
  { id: "minimal", label: "compose · simple", hint: "recommended start" },
  { id: "cached", label: "compose · cached", hint: "+ redis session cache" },
  { id: "production", label: "compose · prod", hint: "full setup" },
]
</script>

<template>
  <section id="code" class="cta-section">
    <div class="container">
      <div
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :visible-once="{ opacity: 1, y: 0, transition: { duration: 400 } }"
        class="cta-inner"
      >
        <div class="cta-label">open source · AGPL-3.0 · self-hosted</div>
        <h2 class="cta-heading">up and running<br />in 60 seconds.</h2>
        <p class="cta-sub">No clone. No build. Pull the image and start.</p>
        <div class="cta-actions">
          <a href="https://github.com/germondai/trawl" target="_blank" rel="noopener noreferrer" class="btn-primary">
            <span class="btn-icon">↗</span>
            view on github
          </a>
          <a :href="docsUrl" class="btn-ghost"> read the docs </a>
        </div>

        <!-- Step 1: Setup -->
        <div class="step-label">1 — choose your setup</div>
        <div class="cta-snippet">
          <div class="setup-tabs">
            <button
              type="button"
              v-for="tab in tabs"
              :key="tab.id"
              class="setup-tab"
              :class="{ active: active === tab.id }"
              @click="active = tab.id"
            >
              {{ tab.label }}
            </button>
          </div>

          <div v-if="active === 'docker'" class="snippet-body-wrap">
            <div class="snippet-bar inner-bar">
              <span class="snippet-hint">no compose needed · fastest to start</span>
            </div>
            <pre class="snippet-body"><code>docker run -d \
  --name trawl \
  -p <span class="s">8191:8191</span> \
  --shm-size=<span class="s">1gb</span> \
  ghcr.io/germondai/<span class="s">trawl:latest</span></code></pre>
          </div>

          <div v-else-if="active === 'minimal'" class="snippet-body-wrap">
            <div class="snippet-bar inner-bar">
              <span class="snippet-hint">single service · pool size 1 · 15s acquire wait · no redis</span>
            </div>
            <pre class="snippet-body"><code><span class="k">services:</span>
  trawl:
    <span class="k">image:</span> <span class="s">ghcr.io/germondai/trawl:latest</span>
    <span class="k">ports:</span> [<span class="s">"8191:8191"</span>]
    <span class="k">shm_size:</span> <span class="s">1gb</span>
    <span class="k">environment:</span>
      <span class="k">BROWSER_POOL_SIZE:</span> <span class="s">1</span>
      <span class="k">BROWSER_ACQUIRE_TIMEOUT_MS:</span> <span class="s">15000</span></code></pre>
          </div>

          <div v-else-if="active === 'cached'" class="snippet-body-wrap">
            <div class="snippet-bar inner-bar">
              <span class="snippet-hint">redis session cache · repeat requests ~500ms</span>
            </div>
            <pre class="snippet-body"><code><span class="k">services:</span>
  redis:
    <span class="k">image:</span> <span class="s">redis:7-alpine</span>
    <span class="k">volumes:</span> [<span class="s">redis_data:/data</span>]
  trawl:
    <span class="k">image:</span> <span class="s">ghcr.io/germondai/trawl:latest</span>
    <span class="k">ports:</span> [<span class="s">"8191:8191"</span>]
    <span class="k">shm_size:</span> <span class="s">1gb</span>
    <span class="k">environment:</span>
      <span class="k">REDIS_URL:</span> <span class="s">redis://redis:6379</span>
      <span class="k">BROWSER_POOL_SIZE:</span> <span class="s">3</span>
      <span class="k">BROWSER_ACQUIRE_TIMEOUT_MS:</span> <span class="s">15000</span>
    <span class="k">depends_on:</span> [<span class="s">redis</span>]
<span class="k">volumes:</span>
  redis_data:</code></pre>
          </div>

          <div v-else-if="active === 'production'" class="snippet-body-wrap">
            <div class="snippet-bar inner-bar">
              <span class="snippet-hint">auto-restart · memory limit · healthcheck</span>
            </div>
            <pre class="snippet-body"><code><span class="k">services:</span>
  redis:
    <span class="k">image:</span> <span class="s">redis:7-alpine</span>
    <span class="k">restart:</span> <span class="s">always</span>
    <span class="k">volumes:</span> [<span class="s">redis_data:/data</span>]
  trawl:
    <span class="k">image:</span> <span class="s">ghcr.io/germondai/trawl:latest</span>
    <span class="k">restart:</span> <span class="s">always</span>
    <span class="k">ports:</span> [<span class="s">"8191:8191"</span>]
    <span class="k">shm_size:</span> <span class="s">1gb</span>
    <span class="k">mem_limit:</span> <span class="s">3g</span>
    <span class="k">environment:</span>
      <span class="k">REDIS_URL:</span> <span class="s">redis://redis:6379</span>
      <span class="k">BROWSER_POOL_SIZE:</span> <span class="s">5</span>
      <span class="k">BROWSER_ACQUIRE_TIMEOUT_MS:</span> <span class="s">15000</span>
    <span class="k">depends_on:</span> [<span class="s">redis</span>]
    <span class="k">healthcheck:</span>
      <span class="k">test:</span> <span class="s">wget -qO- http://localhost:8191/health</span>
      <span class="k">interval:</span> <span class="s">30s</span>
<span class="k">volumes:</span>
  redis_data:</code></pre>
          </div>
        </div>

        <p class="tag-hint">
          Older hardware or a Synology NAS without AVX2 / kernel &lt; 5.1? Swap <code>:latest</code> for
          <code>:baseline</code>
          in the image tag above — degrades gracefully down to kernel 3.10 —
          <a :href="`${docsUrl}/deployment/standalone#older-cpus-synology-nas`">same commands, different runtime</a>.
        </p>

        <!-- Step 2: Start (only for compose tabs) -->
        <template v-if="active !== 'docker'">
          <div class="step-label" style="margin-top: 24px;">2 — start</div>
          <div class="cta-snippet">
            <div class="snippet-bar">
              <span class="snippet-lang">terminal</span>
            </div>
            <pre class="snippet-body"><code><span class="s">docker compose up -d</span></code></pre>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cta-section {
  padding: 100px 0 80px;
  border-top: 1px solid var(--accent);
}

.cta-inner {
  max-width: 680px;
}

.cta-label {
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 20px;
}

.cta-heading {
  font-size: clamp(28px, 5vw, 52px);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.08;
  color: var(--text);
  margin-bottom: 20px;
}

.cta-sub {
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-muted);
  margin-bottom: 36px;
  max-width: 500px;
}

.cta-actions {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 48px;
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: var(--accent);
  color: #000;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-decoration: none;
  transition: opacity 0.12s;
}
.btn-primary:hover {
  opacity: 0.85;
}
.btn-icon {
  font-size: 14px;
  line-height: 1;
}

.btn-ghost {
  display: inline-flex;
  align-items: center;
  padding: 12px 24px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-family: inherit;
  font-size: 12px;
  letter-spacing: 0.05em;
  text-decoration: none;
  transition: all 0.12s;
}
.btn-ghost:hover {
  border-color: var(--text-muted);
  color: var(--text);
}

.step-label {
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 10px;
}

.cta-snippet {
  border: 1px solid var(--border);
  overflow: hidden;
  margin-bottom: 8px;
}

.setup-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
  overflow-x: auto;
}

.setup-tab {
  padding: 10px 16px;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-right: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s;
}
.setup-tab:hover {
  color: var(--text);
  background: var(--bg);
}
.setup-tab.active {
  color: var(--accent);
  background: var(--accent-tint);
  border-bottom: 1px solid var(--accent);
}

.snippet-body-wrap {
  overflow: hidden;
}

.snippet-bar,
.inner-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
}

.snippet-lang {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.snippet-hint {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--border-strong);
}

.tag-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-muted);
  margin-bottom: 24px;
}
.tag-hint code {
  color: var(--text);
  font-family: inherit;
}
.tag-hint a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: var(--border);
  text-underline-offset: 2px;
}
.tag-hint a:hover {
  text-decoration-color: var(--accent);
}

.snippet-body {
  margin: 0;
  padding: 16px 24px;
  background: var(--bg);
  font-size: 12px;
  line-height: 2;
  color: var(--text-muted);
  overflow-x: auto;
}

.snippet-body :deep(.k) {
  color: var(--text);
}
.snippet-body :deep(.s) {
  color: #86efac;
}
.snippet-body :deep(.c) {
  color: var(--border-strong);
}

@media (max-width: 600px) {
  .cta-section {
    padding: 60px 0;
  }
  .cta-actions {
    flex-direction: column;
  }
  .btn-primary,
  .btn-ghost {
    justify-content: center;
  }
}
</style>
