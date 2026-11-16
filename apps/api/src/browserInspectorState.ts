import { BrowserObservations } from "./browserObservation"
import { BROWSER_INSPECTION_ENABLED } from "./config"

export const browserObservations = BROWSER_INSPECTION_ENABLED ? new BrowserObservations() : undefined
