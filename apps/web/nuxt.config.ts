const title = "Self-Hosted Web Scraping & Challenge Bypass"
const description =
  "Adaptive, self-hosted web scraping engine for Cloudflare, Akamai, Imperva, and CAPTCHA-protected sites, with a challenge-aware HTTP/HTTPS proxy."
const socialDescription =
  "Scrape protected websites with adaptive HTTP and browser tiers, CAPTCHA handling, session caching, and a challenge-aware proxy."

export default defineNuxtConfig({
  compatibilityDate: "2026-06-23",

  modules: ["@nuxt/fonts", "@nuxtjs/color-mode", "@nuxtjs/seo", "@vueuse/motion/nuxt"],

  alias: {
    tslib: "tslib/tslib.es6.js",
  },

  colorMode: {
    classSuffix: "",
    fallback: "dark",
    preference: "dark",
  },

  fonts: {
    families: [
      {
        name: "Geist Mono",
        provider: "google",
        weights: ["400", "500", "600", "700"],
        subsets: ["latin"],
      },
    ],
  },

  site: {
    url: "https://trawl.germondai.com",
    name: "TRAWL",
    description,
    defaultLocale: "en",
  },

  seo: {
    meta: {
      themeColor: "#00e87a",
      ogTitle: `TRAWL — ${title}`,
      ogDescription: socialDescription,
      twitterCard: "summary_large_image",
      twitterTitle: `TRAWL — ${title}`,
      twitterDescription:
        "An adaptive web scraping engine for protected sites, with CAPTCHA handling and a general HTTP/HTTPS proxy.",
    },
  },

  ogImage: {
    enabled: false,
  },

  robots: {
    credits: false,
  },

  sitemap: {
    zeroRuntime: true,
  },

  nitro: {
    compressPublicAssets: true,
    routeRules: {
      "/**": {
        headers: {
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://api.github.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          "Referrer-Policy": "strict-origin-when-cross-origin",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      },
      "/_nuxt/**": {
        headers: {
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      },
    },
  },

  app: {
    head: {
      title,
      templateParams: {
        siteName: "TRAWL",
        separator: "—",
      },
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    },
  },
})
