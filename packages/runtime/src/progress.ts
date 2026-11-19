export interface InstallationStep {
  phase: "checking" | "copy" | "download" | "extract" | "patch" | "geoip" | "addons" | "activate" | "remove" | "done"
  completed?: number
  total?: number
  unit?: "bytes" | "files"
}
export interface InstallationProgress extends InstallationStep {
  elapsedMs: number
  etaMs?: number
}
export type ProgressReporter = (step: InstallationStep) => void
export function installationProgress(emit: (value: InstallationProgress) => void): ProgressReporter {
  let phase = "",
    unit: string | undefined,
    started = 0,
    last = 0,
    baseline = 0,
    completed = 0
  return (step) => {
    const now = performance.now()
    const changed =
      step.phase !== phase || step.unit !== unit || (step.completed !== undefined && step.completed < completed)
    if (changed) {
      phase = step.phase
      unit = step.unit
      started = now
      baseline = step.completed ?? 0
    }
    if (!changed && now - last < 250 && step.completed !== step.total) return
    last = now
    completed = step.completed ?? completed
    const elapsedMs = Math.round(now - started)
    const etaMs =
      elapsedMs >= 1000 && step.completed && step.completed > baseline && step.total && step.completed < step.total
        ? Math.round((elapsedMs * (step.total - step.completed)) / (step.completed - baseline))
        : undefined
    emit({ ...step, elapsedMs, ...(etaMs !== undefined ? { etaMs } : {}) })
  }
}
