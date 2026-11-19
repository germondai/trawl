export default defineNuxtPlugin({
  name: "workspace-navigation",
  dependsOn: ["nuxt:router"],
  setup(nuxtApp) {
    const session = { id: "" }
    // Register before NuxtRoot's self-removing hydration guard. Owned steps do not change the URL.
    nuxtApp.$router.beforeEach((to, from) => {
      if (session.id && to.fullPath === from.fullPath && window.history.state?.trawlNavigation?.session === session.id)
        return false
    })
    return { provide: { navigationSession: session } }
  },
})
