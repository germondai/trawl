import {
  defaults,
  type Environment,
  type ResourceProfileValues,
  resourcePresets,
  resourceProfileKeys,
} from "@trawl/config/catalog"

export function resourceOverrides(environment: Environment): ResourceProfileValues {
  return Object.fromEntries(
    resourceProfileKeys.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]),
  )
}
export function applyResourceProfile(environment: Environment, values: ResourceProfileValues): Environment {
  const next = { ...environment }
  for (const key of resourceProfileKeys) {
    if (values[key] === undefined) delete next[key]
    else next[key] = values[key]
  }
  return next
}
export function resourceProfileName(
  environment: Environment,
  inherited: Environment,
  sources: Record<string, string> = {},
) {
  for (const [name, values] of Object.entries(resourcePresets)) {
    if (
      resourceProfileKeys.every(
        (key) =>
          (sources[key] === "environment"
            ? (inherited[key] ?? defaults[key])
            : (environment[key] ?? inherited[key] ?? defaults[key])) === values[key],
      )
    )
      return name === "balanced" ? "Standard" : "Economy"
  }
  return "Modified"
}
