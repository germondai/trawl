<script lang="ts" setup>
const challenges = [
  {
    name: "Cloudflare Interstitial",
    desc: '"Just a moment" redirect page',
    trawl: "4–15s · fresh context",
    trawlSupport: "yes",
    flaresolver: "11–18s",
    fsSupport: "partial",
    byparr: "13–18s",
    byparrSupport: "partial",
  },
  {
    name: "CF Turnstile Widget",
    desc: "Embedded checkbox on target page",
    trawl: "shadow DOM click · auto",
    trawlSupport: "yes",
    flaresolver: "not handled",
    fsSupport: "no",
    byparr: "not handled",
    byparrSupport: "no",
  },
  {
    name: "reCAPTCHA v2",
    desc: "Google checkbox + audio challenge",
    trawl: "Google STT audio · free",
    trawlSupport: "yes",
    flaresolver: "not handled",
    fsSupport: "no",
    byparr: "not handled",
    byparrSupport: "no",
  },
  {
    name: "hCaptcha",
    desc: "Checkbox + image challenge",
    trawl: "auto-pass path · click",
    trawlSupport: "yes",
    flaresolver: "not handled",
    fsSupport: "no",
    byparr: "not handled",
    byparrSupport: "no",
  },
  {
    name: "GeeTest v4 Slide",
    desc: "Drag-to-fit puzzle captcha",
    trawl: "canvas gap detection · drag",
    trawlSupport: "yes",
    flaresolver: "not handled",
    fsSupport: "no",
    byparr: "not handled",
    byparrSupport: "no",
  },
  {
    name: "No protection",
    desc: "Plain HTML, no bot check",
    trawl: "< 100ms · plain HTTP",
    trawlSupport: "yes",
    flaresolver: "2–3s · full browser",
    fsSupport: "partial",
    byparr: "2–3s · full browser",
    byparrSupport: "partial",
  },
]

function icon(s: string) {
  return s === "yes" ? "✓" : s === "partial" ? "~" : "✗"
}
function iconClass(s: string) {
  return s === "yes" ? "cell-yes" : s === "partial" ? "cell-partial" : "cell-no"
}
</script>

<template>
  <section id="captcha" class="section">
    <div class="container">
      <p class="eyebrow">challenge coverage</p>
      <h2 class="section-title">every wall. handled.</h2>
      <p class="section-sub">
        TRAWL is the only self-hosted scraper with native solvers for all major protection layers — not just Cloudflare
        interstitials, but the captchas embedded inside the pages themselves.
      </p>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-name">challenge type</th>
              <th class="col-trawl"><span class="accent">TRAWL</span></th>
              <th>FlareSolverr</th>
              <th>Byparr</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in challenges" :key="c.name">
              <td class="col-name">
                <span class="challenge-name">{{ c.name }}</span>
                <span class="challenge-desc">{{ c.desc }}</span>
              </td>
              <td class="col-trawl">
                <span class="cell-yes">✓</span>
                {{ c.trawl }}
              </td>
              <td>
                <span :class="iconClass(c.fsSupport)">{{ icon(c.fsSupport) }}</span>
                {{ c.flaresolver }}
              </td>
              <td>
                <span :class="iconClass(c.byparrSupport)">{{ icon(c.byparrSupport) }}</span>
                {{ c.byparr }}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td class="col-name score-spacer"></td>
              <td class="col-trawl score-cell">
                <span class="score-num accent">6 / 6</span>
                <span class="score-label">challenge types</span>
              </td>
              <td class="score-cell">
                <span class="score-num">1 / 6</span>
                <span class="score-label">challenge types</span>
              </td>
              <td class="score-cell">
                <span class="score-num">1 / 6</span>
                <span class="score-label">challenge types</span>
              </td>
            </tr>
          </tfoot>
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
  max-width: 580px;
  margin-bottom: 48px;
}

.table-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--border);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  min-width: 580px;
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

tbody tr:last-child td {
  border-bottom: none;
}

tbody tr:hover td {
  background: var(--bg-subtle);
}

/* Challenge name column — allow wrapping */
.col-name {
  white-space: normal;
  min-width: 160px;
  color: var(--text);
}

.challenge-name {
  display: block;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 2px;
}

.challenge-desc {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
}

/* TRAWL column highlight */
.col-trawl {
  background: var(--accent-tint);
}

tbody tr:hover .col-trawl {
  background: color-mix(in srgb, var(--accent-tint) 160%, transparent);
}

/* Support icons */
.cell-yes {
  color: var(--accent);
  font-weight: 700;
  margin-right: 6px;
}
.cell-no {
  color: var(--text-muted);
  opacity: 0.4;
  margin-right: 6px;
}
.cell-partial {
  color: #f59e0b;
  margin-right: 6px;
}

/* Score footer */
tfoot tr td {
  border-top: 2px solid var(--border-strong);
  border-bottom: none;
  background: var(--bg-subtle);
}

.score-spacer {
  background: var(--bg-subtle);
}

.score-cell {
  display: table-cell;
}

.score-num {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-muted);
  margin-right: 6px;
}

.score-label {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  opacity: 0.6;
}
</style>
