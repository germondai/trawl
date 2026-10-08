import { Camoufox } from "camoufox-js"

// Match the worker sizing used by the small-container smoke tests.
export const launchAnubisBrowser = () =>
  Camoufox({
    headless: true,
    geoip: false,
    exclude_addons: process.env.BROWSER_BLOCK_ADS === "false" ? ["UBO"] : [],
    i_know_what_im_doing: true,
    config: { "navigator.hardwareConcurrency": 4 },
    firefox_user_prefs: {
      "dom.ipc.processCount": 2,
      "dom.ipc.contentProcessCount": 2,
      "dom.ipc.processPrelaunch": false,
    },
  })
