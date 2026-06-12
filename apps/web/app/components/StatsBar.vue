<script lang="ts" setup>
const animated = shallowRef(false)
const counts = ref([0, 0, 0, 0])

const cells = [
  { label: "execution tiers", suffix: "", target: 4, prefix: "" },
  { label: "cached domain latency", suffix: "ms", target: 500, prefix: "< " },
  { label: "faster on warm domains", suffix: "×", target: 30, prefix: "" },
  { label: "external API keys needed", suffix: "", target: 0, prefix: "" },
]

function animateTo(index: number, target: number, duration = 900) {
  const start = Date.now()
  const step = () => {
    const progress = Math.min((Date.now() - start) / duration, 1)
    const ease = 1 - (1 - progress) ** 3
    counts.value[index] = ease * target
    if (progress < 1) requestAnimationFrame(step)
    else counts.value[index] = target
  }
  requestAnimationFrame(step)
}

onMounted(() => {
  const el = document.querySelector(".stats-bar")
  if (!el) return
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting && !animated.value) {
        animated.value = true
        cells.forEach((c, i) => {
          animateTo(i, c.target, 800 + i * 120)
        })
        observer.disconnect()
      }
    },
    { threshold: 0.3 },
  )
  observer.observe(el)
})
</script>

<template>
  <section class="section stats-bar">
    <div class="stats-grid">
      <div
        v-for="(cell, i) in cells"
        :key="cell.label"
        v-motion
        :initial="{ opacity: 0, y: 16 }"
        :visible-once="{ opacity: 1, y: 0, transition: { delay: i * 80, duration: 400 } }"
        class="stat-cell"
      >
        <div class="stat-value">
          <span v-if="cell.prefix" class="stat-prefix">{{ cell.prefix }}</span
          ><span class="accent">{{ Math.round(counts[i] ?? 0) }}</span>{{ cell.suffix }}
        </div>
        <div class="stat-label">{{ cell.label }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stats-bar {
  padding: 0;
}

.stats-grid {
  max-width: 1100px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-left: 1px solid var(--border);
}

.stat-cell {
  padding: 40px 32px;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stat-value {
  font-size: clamp(28px, 4vw, 40px);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--text);
}

.stat-prefix {
  color: var(--text);
}

.stat-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

@media (max-width: 700px) {
  .stats-grid {
    grid-template-columns: 1fr 1fr;
    border-left: none;
  }
  .stat-cell {
    padding: 28px 20px;
  }
}

@media (max-width: 400px) {
  .stat-value {
    font-size: clamp(22px, 8vw, 32px);
  }
  .stat-cell {
    padding: 22px 14px;
  }
}
</style>
