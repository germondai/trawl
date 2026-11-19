import type { InjectionKey } from "vue"

export interface SettingTarget {
  name: string
  revision: number
}
export const settingNavigation: InjectionKey<(name: string) => void> = Symbol("setting-navigation")
