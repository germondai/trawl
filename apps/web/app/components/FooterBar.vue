<script lang="ts" setup>
const docsUrl = useDocsUrl()
</script>

<template>
  <footer id="site-footer" class="footer">
    <div class="footer-inner">
      <div class="footer-left">
        <BrandWordmark />
        <span class="sep">·</span>
        <span class="tagline">scrape faster.</span>
      </div>
      <div class="footer-center">
        <a href="https://github.com/germondai/trawl" target="_blank" rel="noopener noreferrer">GitHub</a>
        <a :href="docsUrl">Docs</a>
        <a href="https://github.com/germondai/trawl/releases/tag/v1.11.0" target="_blank" rel="noopener noreferrer"
          >v1.11.0</a
        >
        <a href="https://github.com/germondai/trawl/issues" target="_blank" rel="noopener noreferrer">Issues</a>
        <a href="https://github.com/germondai/trawl/blob/main/LICENSE" target="_blank" rel="noopener noreferrer"
          >AGPL-3.0</a
        >
      </div>
      <div class="footer-right">
        <span class="copy"
          >built by
          <a href="https://github.com/germondai" target="_blank" rel="noopener noreferrer" class="creator"
            >@germondai</a
          ></span
        >
      </div>
    </div>
  </footer>
</template>

<style scoped>
.footer {
  border-top: 1px solid var(--border);
  padding: 24px 0;
}

.footer-inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 32px;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
}

.footer-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sep {
  color: var(--border-strong);
  font-size: 12px;
}

.tagline {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  white-space: nowrap;
}

.footer-center {
  display: flex;
  align-items: center;
  gap: 20px;
}

.footer-center a {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.12s;
}
.footer-center a:hover {
  color: var(--text);
}

.footer-right {
  display: flex;
  justify-content: flex-end;
}

.copy {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.creator {
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.12s;
}
.creator:hover {
  color: var(--accent);
}

@media (max-width: 640px) {
  .footer-inner {
    flex-direction: column;
    gap: 14px;
    text-align: center;
    padding: 0 16px;
  }
  .footer-left,
  .footer-center,
  .footer-right {
    justify-content: center;
  }
  .footer-center {
    flex-wrap: wrap;
    gap: 12px 16px;
  }
}
</style>
