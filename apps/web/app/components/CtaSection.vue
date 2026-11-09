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
const setups: Record<Tab, string> = {
  docker:
    "docker run -d --name trawl \\\n  -p 127.0.0.1:8191:8191 \\\n  --shm-size=1gb \\\n  -e SESSION_CACHE_DRIVER=memory \\\n  -e METRICS_DASHBOARD_ENABLED=true \\\n  -e MCP_ENABLED=true \\\n  -e BROWSER_POOL_SIZE=1 \\\n  -v trawl_metrics:/data/metrics \\\n  ghcr.io/germondai/trawl:1.11.0",
  minimal:
    'services:\n  trawl:\n    image: ghcr.io/germondai/trawl:1.11.0\n    ports: ["127.0.0.1:8191:8191"]\n    shm_size: 1gb\n    environment:\n      SESSION_CACHE_DRIVER: memory\n      BROWSER_POOL_SIZE: 1\n      METRICS_DASHBOARD_ENABLED: "true"\n      MCP_ENABLED: "true"\n    volumes: [trawl_metrics:/data/metrics]\n    restart: unless-stopped\nvolumes:\n  trawl_metrics:',
  cached:
    'services:\n  redis:\n    image: redis:8.10.3-alpine\n    command: ["redis-server", "--appendonly", "yes"]\n    volumes: [redis_data:/data]\n    healthcheck:\n      test: ["CMD", "redis-cli", "ping"]\n  trawl:\n    image: ghcr.io/germondai/trawl:1.11.0\n    ports: ["127.0.0.1:8191:8191"]\n    shm_size: 1gb\n    environment:\n      REDIS_URL: redis://redis:6379\n      BROWSER_POOL_SIZE: 1\n      METRICS_DASHBOARD_ENABLED: "true"\n      MCP_ENABLED: "true"\n    volumes: [trawl_metrics:/data/metrics]\n    depends_on:\n      redis:\n        condition: service_healthy\nvolumes:\n  redis_data:\n  trawl_metrics:',
  production:
    'services:\n  redis:\n    image: redis:8.10.3-alpine\n    command: ["redis-server", "--appendonly", "yes"]\n    restart: unless-stopped\n    volumes: [redis_data:/data]\n    healthcheck:\n      test: ["CMD", "redis-cli", "ping"]\n  trawl:\n    image: ghcr.io/germondai/trawl:1.11.0\n    restart: unless-stopped\n    ports: ["127.0.0.1:8191:8191"]\n    shm_size: 1gb\n    environment:\n      REDIS_URL: redis://redis:6379\n      BROWSER_POOL_SIZE: 1\n      METRICS_DASHBOARD_ENABLED: "true"\n      MCP_ENABLED: "true"\n    volumes: [trawl_metrics:/data/metrics]\n    depends_on:\n      redis:\n        condition: service_healthy\n    healthcheck:\n      test: ["CMD", "curl", "-sf", "http://localhost:8191/health"]\n      interval: 30s\nvolumes:\n  redis_data:\n  trawl_metrics:',
}
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
        <h2 class="cta-heading">start with one browser.</h2>
        <p class="cta-sub">
          Run v1.11.0 with MCP enabled and persistent dashboard history. Pull the image, wait for /health, then send
          your first request.
        </p>
        <div class="cta-actions">
          <a href="https://github.com/germondai/trawl" target="_blank" rel="noopener noreferrer" class="btn-primary">
            <span class="btn-icon">↗</span>
            view on github
          </a>
          <a :href="docsUrl" class="btn-ghost"> read the docs </a>
        </div>

        <!-- Step 1: Setup -->
        <div class="step-label">1 - choose your setup</div>
        <div class="cta-snippet">
          <fieldset class="setup-tabs">
            <legend class="sr-only">Installation method</legend>
            <button
              type="button"
              v-for="tab in tabs"
              :key="tab.id"
              class="setup-tab"
              :class="{ active: active === tab.id }"
              :aria-pressed="active === tab.id"
              @click="active = tab.id"
            >
              {{ tab.label }}
            </button>
          </fieldset>

          <div class="snippet-body-wrap">
            <div class="snippet-bar inner-bar">
              <span class="snippet-hint">{{ tabs.find((tab) => tab.id === active)?.hint }}</span>
            </div>
            <pre class="snippet-body"><code>{{ setups[active] }}</code></pre>
          </div>
        </div>

        <p class="tag-hint">
          For older CPUs or NAS deployments, use <code>:1.11.0-baseline</code>. Heavy pages and extra sessions may need
          more memory.
          <a :href="`${docsUrl}/deployment/standalone#older-cpus-synology-nas`">same commands, different runtime</a>.
        </p>

        <p class="tag-hint">
          Dashboard: <code>http://localhost:8191/dashboard</code>. MCP: <code>http://localhost:8191/mcp</code>. Start
          commands expose the API on localhost; other containers can use <code>http://trawl:8191</code> on the same
          Docker network.
        </p>
        <!-- Step 2: Start (only for compose tabs) -->
        <template v-if="active !== 'docker'">
          <div class="step-label" style="margin-top: 24px;">2 - start</div>
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
  transition:
    color 0.12s,
    border-color 0.12s;
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
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
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
  transition:
    color 0.12s,
    background-color 0.12s,
    border-color 0.12s;
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
