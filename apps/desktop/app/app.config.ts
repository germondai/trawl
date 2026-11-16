export default defineAppConfig({
  ui: {
    colors: { primary: "green", neutral: "zinc" },
    button: { defaultVariants: { size: "md" } },
    input: { slots: { root: "w-full" } },
    select: { slots: { base: "w-full" } },
  },
})
