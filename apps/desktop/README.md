# TRAWL desktop (unreleased)

Tauri 2 with a static Nuxt/NuxtUI frontend. The system WebView displays local controls and the native API dashboard. It does not run the scraping browser or keep a separate Nuxt server alive.

```sh
bun --cwd packages/runtime build
bun --cwd apps/desktop native:dev
# Platform package; macOS uses a local ad-hoc signature by default:
bun --cwd apps/desktop native:package
```

The macOS development bundle uses [Tauri's ad-hoc signing mode](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing) to seal its bundle resources. An explicit `APPLE_SIGNING_IDENTITY` overrides that default for a distribution build. Ad-hoc signing does not provide Developer ID trust or notarization; public distribution still requires the signing and installation checks in the v2 plan.

On first use, install the browser from Overview, then start the local server. The collapsible sidebar opens the dashboard, browser manager, server settings, logs and saved connections. Settings are grouped by topic, searchable across categories, and show readable units and inherited values. Standard/Economy presets remain opt-in. Runtime settings apply after restarting the server. Existing Docker installations are not modified.

The first window close asks whether to keep running in the tray or quit completely. Tray mode destroys the WebView to release its memory; Open TRAWL recreates it. Quit stops a server owned by this application, not one started by the CLI. Start at login and start the server with the application are separate, opt-in preferences under Connections.

Saved remote connections provide dashboard access over the native API. Configure remote settings on the remote host. Keys stay in private local storage and are added by Rust to the selected connection; frontend code cannot select arbitrary HTTP methods or administration endpoints.

For Prowlarr or Jackett running in OrbStack on the same Mac, use `http://host.docker.internal:<port>` as the FlareSolverr address, using the port configured in TRAWL. `host.orb.internal` is also accepted. `localhost` inside a bridge-network container refers to that container. The desktop server keeps its loopback listener and cross-origin browser protection.

Use native controls for lifecycle checks. The frontend can also be previewed with `bun run dev`, but a browser preview cannot install or manage the native server. Run one heavy local build at a time with `CARGO_BUILD_JOBS=2` and check disk space first.

The Browser page shows the installed and supported versions and the local installation path. Stop the server before repair, a compatible version update or uninstall. These operations cannot replace a managed browser in use. Repair preserves the previous installation until its verified replacement is ready; uninstall keeps settings and request history. Browser versions are pinned to the compatible runtime build, rather than selected from arbitrary upstream releases.

The shell uses a 240px sidebar that collapses to a 64px rail, a fixed inner header and one independently scrolling workspace. The sidebar header and footer mirror the pane edges, with centered 40px brand/status controls inside 64px content rows; its main-pane divider appears only after scrolling. Menus, popovers, selects and tooltips within the workspace use the pane as their collision boundary with 12px padding. Back/Forward, the Overview logo, instance selection and native close/quit requests share the unsaved-settings guard. A failed save keeps the draft; Reset/Save stays at the bottom of the pane only while changes exist. Configuration editors wait for the saved configuration to load before allowing edits.

On macOS, real window controls follow the header reservation, including sidebar animation. Native window-update notifications restore alignment after AppKit relayouts without requiring a WebView resize; already aligned controls are left in place. The window is prepared while hidden, using bundled Urbanist fonts, icons and the TRAWL logo; an eight-second recovery screen offers Reload if preparation stalls. Frame restoration fits the current display's usable area and reattaches observers after tray recreation. Frame persistence is currently macOS-only. Trackpad history gestures are not implemented.

Shell validation: browser frame sampling covers both animation directions, rapid reversal, reduced motion, dirty navigation, failed saves and narrow-window overflow. Native development checks cover direct startup on Retina, headless background startup and single-instance recreation. Physical dragging, fullscreen and monitor-change checks still require native manual verification; browser checks do not establish those behaviors. `TRAWL_WINDOW_PROFILE=1` in a debug build logs measured AppKit control alignment without enabling it in normal use.

The instance menu provides a selectable address and a copy button with success/failure feedback. Activity inspection supports pointer input and the keyboard; capacity shows available, busy, sleeping and unavailable slots alongside queue/live counts and the server working set when reported. Overview previews the five newest requests; Show all opens Requests through the same page history as the sidebar. Request targets open recorded metadata, including source, status, tier and failure classification.

New request sends HTML, read, extract, screenshot and diagnostic operations to the selected instance. Headers, JSON bodies, session and advanced options use the native API. Drafts remain in memory; stopping a local wait does not guarantee cancellation of accepted server work. No ambiguous request is retried automatically.

Remote settings are read-only. Settings, request history and separate request/log streams require `OBSERVABILITY_ENABLED=true` and a private dashboard token of at least 32 characters. First setup enables observability for a desktop-owned instance unless explicitly configured otherwise. Older instances retain their supported dashboard features; new endpoints require an updated server. Instance credentials stay in the native transport.

History remains metadata-only by default. `HISTORY_CAPTURE_MODE=html`, `screenshot` or `both` enables bounded saved content on that instance, with configurable artifact size, total file budget, record count and age. Details download only the selected artifact and render an inert HTML preview or JPEG without repeating the scrape. HTML previews omit scripts, forms and external resources. The device-local preview preference does not change the remote capture policy.

`BROWSER_INSPECTION_ENABLED=true` separately enables observation of actual request/kept-session pages. Browser offers a single screenshot or explicit live refresh, limited to about one frame per second; it does not navigate, resize or acquire another browser. A visible debug session additionally requires a configured headful pool on macOS/Windows. Linux virtual-display browsers are labelled accordingly. Leaving the inspector stops previews, while an accepted session remains owned by its server until closed or expired.

Server access, limits and configuration are documented in [the observability API reference](../docs/api-reference/observability.md). Native targets must pass platform CI, installer and macOS/Windows signing checks before public distribution.
