import { defineConfig } from "tsdown"
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  outExtensions: () => ({ js: ".mjs" }),
  banner: "#!/usr/bin/env bun",
  deps: { alwaysBundle: [/^@trawl\/(config|runtime)$/], neverBundle: ["@trawl/client"] },
})
