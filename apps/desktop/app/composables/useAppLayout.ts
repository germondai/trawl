export const useAppLayout = createSharedComposable(() => {
  const television = /TRAWL-TV/.test(navigator.userAgent)
  const wide = useMediaQuery("(min-width: 1024px)")
  return { television, phone: computed(() => !television && !wide.value) }
})
