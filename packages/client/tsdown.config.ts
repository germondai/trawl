import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2022",
  dts: true,
  clean: true,
  deps: {
    neverBundle: ["ofetch"],
    onlyImport: ["ofetch"],
  },
})
