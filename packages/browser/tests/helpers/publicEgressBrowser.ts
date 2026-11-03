import { Camoufox } from "camoufox-js"
import { PROXY_SAFETY_FIREFOX_PREFS } from "../../src/pool"

export const launchPublicEgressBrowser = () =>
  Camoufox({
    headless: true,
    main_world_eval: true,
    geoip: false,
    block_webrtc: true,
    exclude_addons: ["UBO"],
    i_know_what_im_doing: true,
    firefox_user_prefs: {
      ...PROXY_SAFETY_FIREFOX_PREFS,
      "dom.ipc.processCount": 2,
      "dom.ipc.contentProcessCount": 2,
      "dom.ipc.processPrelaunch": false,
    },
  })
