<script lang="ts" setup>
const barsVisible = shallowRef(false)

onMounted(() => {
  const el = document.querySelector(".bench-grid")
  if (!el) return
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        barsVisible.value = true
        observer.disconnect()
      }
    },
    { threshold: 0.2 },
  )
  observer.observe(el)
})

const benchmarks = [
  {
    url: "nowsecure.nl",
    type: "No CF protection (Tier 1)",
    maxMs: 3100,
    results: [
      { name: "TRAWL", ms: 200, label: "0.2s", winner: true },
      { name: "FlareSolverr", ms: 2600, label: "2.6s", winner: false },
      { name: "Byparr", ms: 3100, label: "3.1s", winner: false },
    ],
  },
  {
    url: "iplocation.net",
    type: "Cloudflare interstitial (Tier 3)",
    maxMs: 18700,
    results: [
      { name: "TRAWL", ms: 4200, label: "4.2s", winner: true },
      { name: "FlareSolverr", ms: 11300, label: "11.3s", winner: false },
      { name: "Byparr", ms: 18700, label: "18.7s", winner: false },
    ],
  },
  {
    url: "nopecha.com/demo/cloudflare",
    type: "CF + Turnstile (Tier 3)",
    maxMs: 18200,
    results: [
      { name: "TRAWL", ms: 5900, label: "5.9s", winner: true },
      { name: "FlareSolverr", ms: 13200, label: "13.2s", winner: false },
      { name: "Byparr", ms: 18200, label: "18.2s", winner: false },
    ],
  },
]

const rows = [
  { feature: "Persistent browser pool", trawl: "✓ N instances", flaresolver: "✗ 1 instance", byparr: "✗ 1 instance" },
  {
    feature: "Domain session cache",
    trawl: "✓ Redis, <500ms repeat",
    flaresolver: "✗ always full solve",
    byparr: "✗ always full solve",
  },
  { feature: "Adaptive tier execution", trawl: "✓ 4 tiers", flaresolver: "✗ always browser", byparr: "~" },
  { feature: "Browser engine", trawl: "✓ Camoufox Firefox", flaresolver: "✗ Chrome", byparr: "✓ Camoufox Firefox" },
  { feature: "Docker image size", trawl: "✓ 1.18 GB", flaresolver: "✓ 1.03 GB", byparr: "✗ 4.10 GB" },
  { feature: "Memory footprint (peak)", trawl: "✓ 770 MB", flaresolver: "✗ 500 MB", byparr: "✗ 1.35 GB" },
  { feature: "Cloudflare challenge speed", trawl: "✓ 4–15s", flaresolver: "✗ 11–18s", byparr: "✗ 13–18s" },
  { feature: "CF Turnstile solving", trawl: "✓ shadow DOM click", flaresolver: "✗", byparr: "✗" },
  { feature: "reCAPTCHA v2 solving", trawl: "✓ audio STT (free)", flaresolver: "✗", byparr: "✗" },
  { feature: "hCaptcha solving", trawl: "✓ auto-pass", flaresolver: "✗", byparr: "✗" },
  { feature: "GeeTest v4 solving", trawl: "✓ canvas gap detection", flaresolver: "✗", byparr: "✗" },
  { feature: "Custom headers (all tiers)", trawl: "✓ all 4 tiers", flaresolver: "✗", byparr: "✗" },
  { feature: "Proxy escalation", trawl: "✓ DC + residential", flaresolver: "✗", byparr: "~" },
  { feature: "Self-healing pool", trawl: "✓", flaresolver: "✗", byparr: "✗" },
  { feature: "FlareSolverr v2 compat", trawl: "✓", flaresolver: "✓ native", byparr: "✓" },
  {
    feature: "External solver APIs",
    trawl: "✓ none required",
    flaresolver: "✓ none required",
    byparr: "✓ none required",
  },
  { feature: "Self-hosted", trawl: "✓", flaresolver: "✓", byparr: "✓" },
]

function renderCell(val: string) {
  if (val.startsWith("✓")) return `<span class="check">${val}</span>`
  if (val.startsWith("✗")) return `<span class="cross">${val}</span>`
  if (val.startsWith("~")) return `<span class="partial">${val}</span>`
  return val
}
</script>

<template>
  <section id="compare" class="section">
    <div class="container">
      <p class="eyebrow">benchmarks</p>
      <h2 class="section-title">TRAWL vs the alternatives.</h2>
      <p class="section-sub">Measured on the same machine, same network, same target URLs.</p>

      <div class="bench-grid">
        <div
          v-for="b in benchmarks"
          :key="b.url"
          v-motion
          :initial="{ opacity: 0, y: 16 }"
          :visible-once="{ opacity: 1, y: 0, transition: { duration: 400 } }"
          class="bench-card"
        >
          <div class="bench-url">{{ b.url }}</div>
          <div class="bench-type">{{ b.type }}</div>
          <div class="bench-bars">
            <div v-for="r in b.results" :key="r.name" class="bench-row">
              <span class="bench-name" :class="{ 'bench-winner': r.winner }">{{ r.name }}</span>
              <div class="bench-bar-wrap">
                <div
                  class="bench-bar"
                  :class="{ 'bench-bar-winner': r.winner }"
                  :style="{ width: barsVisible ? `${(r.ms / b.maxMs) * 100}%` : '0%' }"
                />
              </div>
              <span class="bench-ms" :class="{ 'accent': r.winner }">{{ r.label }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="table-wrap" style="margin-top: 56px;">
        <table>
          <thead>
            <tr>
              <th>capability</th>
              <th class="col-trawl"><span class="accent">TRAWL</span></th>
              <th>FlareSolverr</th>
              <th>Byparr</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.feature">
              <td class="feature-col">{{ row.feature }}</td>
              <td class="col-trawl" v-html="renderCell(row.trawl)" />
              <td v-html="renderCell(row.flaresolver)" />
              <td v-html="renderCell(row.byparr)" />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.section-title {
  font-size: clamp(22px, 3vw, 34px);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  margin-bottom: 12px;
}

.section-sub {
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-muted);
  max-width: 540px;
  margin-bottom: 48px;
}

/* ── Benchmark cards ── */
.bench-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--border);
}

.bench-card {
  background: var(--bg);
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.bench-url {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.01em;
}

.bench-type {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-top: -8px;
}

.bench-bars {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bench-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bench-name {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  min-width: 72px;
  flex-shrink: 0;
}

.bench-winner {
  color: var(--accent);
  font-weight: 600;
}

.bench-bar-wrap {
  flex: 1;
  height: 4px;
  background: var(--border);
}

.bench-bar {
  height: 100%;
  background: var(--border-strong);
  transition: width 1.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.bench-bar-winner {
  background: var(--accent);
}

.bench-ms {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  min-width: 36px;
  text-align: right;
  flex-shrink: 0;
}

/* ── Feature table ── */
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

th,
td {
  padding: 12px 18px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

th {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  background: var(--bg-subtle);
  font-weight: 600;
}

td {
  color: var(--text-muted);
}

.feature-col {
  color: var(--text);
  font-weight: 500;
  white-space: normal;
}

.col-trawl {
  background: var(--accent-tint);
}

tr:last-child td {
  border-bottom: none;
}
tr:hover td {
  background: var(--bg-subtle);
}
tr:hover .col-trawl {
  background: color-mix(in srgb, var(--accent-tint) 150%, transparent);
}

:deep(.check) {
  color: var(--accent);
  font-weight: 600;
}
:deep(.cross) {
  color: var(--text-muted);
  opacity: 0.4;
}
:deep(.partial) {
  color: #f59e0b;
}

@media (max-width: 800px) {
  .bench-grid {
    grid-template-columns: 1fr;
  }
}
</style>
