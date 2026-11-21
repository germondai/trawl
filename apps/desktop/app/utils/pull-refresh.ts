export const pullRefreshThreshold = 80

export function createPullRefresh(options: { feedback(distance: number): void; refresh(): void }) {
  let start: { x: number; y: number; owned: boolean } | undefined
  let distance = 0
  const reset = () => {
    start = undefined
    distance = 0
    options.feedback(0)
  }
  return {
    reset,
    start(x: number, y: number, eligible: boolean) {
      reset()
      if (eligible) start = { x, y, owned: false }
    },
    move(x: number, y: number) {
      if (!start) return false
      const dx = x - start.x,
        dy = y - start.y
      if (!start.owned) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return false
        if (dy <= 0 || Math.abs(dx) > dy) {
          reset()
          return false
        }
        start.owned = true
      }
      distance = Math.min(pullRefreshThreshold * 1.5, Math.max(0, dy * 0.45))
      options.feedback(distance)
      return true
    },
    finish(cancelled = false) {
      const refresh = !cancelled && distance >= pullRefreshThreshold
      reset()
      if (refresh) options.refresh()
    },
  }
}
