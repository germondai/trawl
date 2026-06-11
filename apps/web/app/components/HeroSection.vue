<template>
  <section class="hero">
    <div class="hero-bg" aria-hidden="true" />
    <div class="container hero-inner">
      <div
        v-motion
        :initial="{ opacity: 0, y: -10 }"
        :enter="{ opacity: 1, y: 0, transition: { duration: 400 } }"
        class="hero-badge"
      >
        <span class="badge-dot" />
        open source · self-hosted · zero external APIs
      </div>

      <h1
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :enter="{ opacity: 1, y: 0, transition: { duration: 500, delay: 100 } }"
        class="hero-heading"
      >
        <span class="line-1">bypass anything.</span>
        <span class="line-2 accent">return in 500ms.</span>
      </h1>

      <p
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :enter="{ opacity: 1, y: 0, transition: { duration: 500, delay: 200 } }"
        class="hero-copy"
      >
        An adaptive, self-hosted scraping engine — tries the cheapest path first and only escalates when needed. Solves
        Cloudflare challenges natively in 4–15 seconds. Caches browser sessions per domain and returns sub-500ms on
        every repeat request.
        <em>No tokens. No quotas. No cloud. Just Docker.</em>
      </p>

      <div
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :enter="{ opacity: 1, y: 0, transition: { duration: 500, delay: 300 } }"
        class="hero-actions"
      >
        <a href="#code" class="btn btn-primary">deploy now</a>
        <a href="https://github.com/germondai/trawl" target="_blank" rel="noopener" class="btn btn-outline">
          ⋆ view source
        </a>
      </div>

      <div
        v-motion
        :initial="{ opacity: 0 }"
        :enter="{ opacity: 1, transition: { duration: 600, delay: 500 } }"
        class="hero-stats"
      >
        <div class="hero-stat">
          <span class="hero-stat-num accent">&lt; 500ms</span>
          <span class="hero-stat-label">cached domain response</span>
        </div>
        <div class="hero-stat-divider" />
        <div class="hero-stat">
          <span class="hero-stat-num accent">4–15s</span>
          <span class="hero-stat-label">fresh CF challenge solve</span>
        </div>
        <div class="hero-stat-divider" />
        <div class="hero-stat">
          <span class="hero-stat-num accent">4</span>
          <span class="hero-stat-label">execution tiers</span>
        </div>
      </div>
    </div>

    <div class="ticker-wrap" aria-hidden="true">
      <div class="ticker-track ticker-fwd">
        <span v-for="i in 4" :key="i">
          adaptive tier engine · cloudflare bypass · session cache · camoufox firefox · turnstile solver · recaptcha
          audio · geetest slide · hcaptcha · proxy escalation · self-healing pool ·
        </span>
      </div>
      <div class="ticker-track ticker-rev">
        <span v-for="i in 4" :key="i">
          persistent pool · domain stickiness · zero cold starts · flaresolver compat · prowlarr · jackett · sonarr ·
          radarr · redis cache · open source ·
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero {
  position: relative;
  min-height: calc(100vh - 60px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
}

.hero-bg {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(ellipse 60% 40% at 50% -10%, var(--accent-tint) 0%, transparent 70%);
  pointer-events: none;
}

.hero-inner {
  padding-top: 80px;
  padding-bottom: 60px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 28px;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.badge-dot {
  width: 6px;
  height: 6px;
  background: var(--accent);
  flex-shrink: 0;
  animation: blink 2s ease-in-out infinite;
}

.hero-heading {
  font-size: clamp(40px, 7vw, 82px);
  font-weight: 700;
  line-height: 1.04;
  letter-spacing: -0.03em;
}

.line-1,
.line-2 {
  display: block;
}

.hero-copy {
  font-size: 15px;
  line-height: 1.8;
  color: var(--text-muted);
  max-width: 620px;
}

.hero-copy em {
  font-style: normal;
  color: var(--text);
}

.hero-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.hero-stats {
  display: flex;
  align-items: center;
  gap: 24px;
  padding-top: 8px;
}

.hero-stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hero-stat-num {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.hero-stat-label {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}

.hero-stat-divider {
  width: 1px;
  height: 32px;
  background: var(--border-strong);
}

.ticker-wrap {
  width: 100%;
  overflow: hidden;
  border-top: 1px solid var(--border);
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: auto;
}

.ticker-track {
  display: flex;
  white-space: nowrap;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--border-strong);
  gap: 0;
}

.ticker-fwd {
  animation: scroll-left 70s linear infinite;
}
.ticker-rev {
  animation: scroll-right 70s linear infinite;
}

@keyframes scroll-left {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
@keyframes scroll-right {
  from {
    transform: translateX(-50%);
  }
  to {
    transform: translateX(0);
  }
}

@media (max-width: 640px) {
  .hero-inner {
    padding-top: 36px;
    padding-bottom: 36px;
    gap: 20px;
    align-items: center;
    text-align: center;
  }
  .hero-badge {
    text-align: center;
  }
  .hero-copy {
    font-size: 13px;
    text-align: center;
  }
  .hero-actions {
    justify-content: center;
  }
  .hero-stats {
    flex-wrap: wrap;
    justify-content: center;
    gap: 16px 28px;
  }
  .hero-stat {
    align-items: center;
  }
  .hero-stat-divider {
    display: none;
  }
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
</style>
