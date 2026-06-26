import { defineConfig } from "vitepress"

export default defineConfig({
  title: "TRAWL",
  description:
    "Self-hosted Scraping-as-a-Service — FlareSolverr drop-in with a persistent browser pool and domain session cache.",
  lang: "en-US",

  cleanUrls: true,
  lastUpdated: true,

  transformPageData(pageData) {
    if (pageData.relativePath === "index.md") {
      pageData.frontmatter.head ??= []
      pageData.frontmatter.head.push([
        "meta",
        { "http-equiv": "refresh", content: "0;url=/getting-started/quick-start" },
      ])
    }
  },

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#00e87a" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "TRAWL Docs" }],
  ],

  themeConfig: {
    logo: { light: "/logo-light.svg", dark: "/logo-dark.svg", alt: "TRAWL" },
    siteTitle: "TRAWL",

    nav: [
      { text: "Docs", link: "/getting-started/quick-start" },
      { text: "API", link: "/api-reference/overview" },
      { text: "GitHub", link: "https://github.com/germondai/trawl" },
    ],

    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Quick Start", link: "/getting-started/quick-start" },
          { text: "Configuration", link: "/getting-started/configuration" },
          { text: "Local Development", link: "/getting-started/local-development" },
        ],
      },
      {
        text: "Integrations",
        items: [
          { text: "Prowlarr", link: "/integrations/prowlarr" },
          { text: "Jackett", link: "/integrations/jackett" },
          { text: "*arr Apps", link: "/integrations/arr-apps" },
        ],
      },
      {
        text: "API Reference",
        items: [
          { text: "Overview", link: "/api-reference/overview" },
          { text: "FlareSolverr Compat", link: "/api-reference/flaresolvr-compat" },
          { text: "Native API", link: "/api-reference/native-api" },
          { text: "Custom Headers", link: "/api-reference/custom-headers" },
          { text: "Health & Stats", link: "/api-reference/health-stats" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Overview", link: "/architecture/overview" },
          { text: "Tiered Execution", link: "/architecture/tiered-execution" },
          { text: "Browser Pool", link: "/architecture/browser-pool" },
          { text: "Session Cache", link: "/architecture/session-cache" },
        ],
      },
      {
        text: "Deployment",
        items: [
          { text: "Docker Compose", link: "/deployment/docker-compose" },
          { text: "Standalone Containers", link: "/deployment/standalone" },
          { text: "Troubleshooting", link: "/deployment/troubleshooting" },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/germondai/trawl" }],

    footer: {
      message:
        'Released under the <a href="https://github.com/germondai/trawl/blob/main/LICENSE" target="_blank">AGPL-3.0 License</a>.',
      copyright: 'TRAWL — built by <a href="https://github.com/germondai" target="_blank">@germondai</a>',
    },

    search: {
      provider: "local",
    },

    editLink: {
      pattern: "https://github.com/germondai/trawl/edit/main/apps/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
})
