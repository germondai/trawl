export function useGithubStars() {
  const stars = shallowRef<string>()

  onMounted(async () => {
    try {
      const res = await fetch("https://api.github.com/repos/germondai/trawl", {
        headers: { Accept: "application/vnd.github+json" },
      })
      if (!res.ok) return
      const data = await res.json()
      const n = data.stargazers_count
      if (typeof n !== "number") return
      stars.value = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
    } catch {
      // stays null — GitHub link still renders without the count
    }
  })

  return stars
}
