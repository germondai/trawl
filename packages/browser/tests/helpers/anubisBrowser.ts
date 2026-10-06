import { Camoufox } from "camoufox-js"

export const launchAnubisBrowser = () => Camoufox({ headless: true, geoip: false })
