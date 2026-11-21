import { computed, shallowRef } from "vue"
import { nativeErrorMessage } from "../utils/localization"

/** Keep the original error so visible messages follow later language changes. */
export function useErrorMessage() {
  const cause = shallowRef<unknown>("")
  return computed({
    get: () => nativeErrorMessage(cause.value),
    set: (value: unknown) => {
      cause.value = value
    },
  })
}
