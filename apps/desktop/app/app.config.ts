export default defineAppConfig({
  ui: {
    colors: { primary: "green", neutral: "zinc" },
    button: { defaultVariants: { size: "md" } },
    input: { slots: { root: "w-full" } },
    select: { slots: { base: "w-full", content: "navigation-popup" } },
    popover: { slots: { content: "navigation-popup" } },
    dropdownMenu: { slots: { content: "navigation-popup" } },
    modal: {
      slots: {
        header: "relative shrink-0 items-start p-6 pe-16 sm:px-6 sm:pe-16",
        wrapper: "min-w-0 w-full",
        body: "min-h-0 overflow-y-auto p-6 sm:p-6",
        title: "text-base font-medium",
        description: "text-sm leading-relaxed",
        footer: "shrink-0 justify-end flex-wrap gap-2 p-6 sm:px-6",
        close: "absolute top-6 end-6",
      },
    },
  },
})
