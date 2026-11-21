use crate::{runtime, AppState};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

pub struct Instances {
    selected: Mutex<String>,
    requested: Mutex<Option<String>>,
    choices: Mutex<Vec<(String, String)>>,
    shortcuts: Mutex<Vec<Option<String>>>,
    menu: Mutex<Option<Submenu<tauri::Wry>>>,
}
impl Default for Instances {
    fn default() -> Self {
        Self {
            selected: Mutex::new("local".into()),
            requested: Mutex::new(None),
            choices: Mutex::new(vec![("local".into(), String::new())]),
            shortcuts: Mutex::new(Vec::new()),
            menu: Mutex::new(None),
        }
    }
}
impl Instances {
    fn request(&self, id: &str, renderer_ready: bool) -> Result<bool, String> {
        if !self
            .choices
            .lock()
            .unwrap()
            .iter()
            .any(|(candidate, _)| candidate == id)
        {
            return Err("Unknown instance".into());
        }
        if *self.selected.lock().unwrap() == id {
            *self.requested.lock().unwrap() = None;
            return Ok(false);
        }
        if renderer_ready {
            *self.requested.lock().unwrap() = Some(id.into());
        } else {
            *self.selected.lock().unwrap() = id.into();
            *self.requested.lock().unwrap() = None;
        }
        Ok(renderer_ready)
    }
}

fn stopped_icon(image: &Image<'_>) -> Image<'static> {
    let mut pixels = image.rgba().to_vec();
    for pixel in pixels.chunks_exact_mut(4) {
        let gray =
            ((299 * pixel[0] as u32 + 587 * pixel[1] as u32 + 114 * pixel[2] as u32) / 1000) as u8;
        pixel[..3].fill(gray);
    }
    Image::new_owned(pixels, image.width(), image.height())
}
struct StatusIcon {
    colored: Image<'static>,
    stopped: Image<'static>,
    running: AtomicBool,
}
impl StatusIcon {
    fn update(&self, app: &tauri::AppHandle, running: bool) {
        if self.running.swap(running, Ordering::SeqCst) == running {
            return;
        }
        if let Some(tray) = app.tray_by_id("main") {
            if let Err(error) = tray.set_icon(Some(if running {
                self.colored.clone()
            } else {
                self.stopped.clone()
            })) {
                self.running.store(!running, Ordering::SeqCst);
                eprintln!("Cannot update TRAWL status icon: {error}");
            }
        }
    }
}
fn is_local(app: &tauri::AppHandle) -> bool {
    *app.state::<Instances>().selected.lock().unwrap() == "local"
}
fn instance_shortcuts(app: &tauri::AppHandle) -> Vec<Option<String>> {
    (1..=9)
        .map(|index| crate::keybindings::binding(app, &format!("trayInstance{index}")))
        .collect()
}
pub(crate) fn render_instances(app: &tauri::AppHandle) -> tauri::Result<()> {
    let state = app.state::<Instances>();
    let Some(menu) = state.menu.lock().unwrap().clone() else {
        return Ok(());
    };
    let selected = state.selected.lock().unwrap().clone();
    let choices = state.choices.lock().unwrap().clone();
    let shortcuts = instance_shortcuts(app);
    let default_name = crate::i18n::text("ui.localInstance");
    let label = choices
        .iter()
        .find(|(id, _)| id == &selected)
        .map(|(_, label)| label.as_str())
        .filter(|label| !label.is_empty())
        .unwrap_or(&default_name);
    menu.set_text(crate::i18n::format("native.instance", &[("name", label)]))?;
    for item in menu.items()? {
        menu.remove(&item)?;
    }
    for (index, (id, label)) in choices.into_iter().enumerate() {
        let label = if id == "local" && label.is_empty() {
            default_name.clone()
        } else {
            label
        };
        menu.append(&CheckMenuItem::with_id(
            app,
            format!("instance:{id}"),
            label,
            true,
            id == selected,
            shortcuts
                .get(index)
                .and_then(|shortcut| shortcut.as_deref()),
        )?)?;
    }
    Ok(())
}
fn instance_choices(config: &serde_json::Value) -> Vec<(String, String)> {
    let desktop = &config["desktop"];
    let mut remaining = vec![(
        "local".to_string(),
        desktop["localName"].as_str().unwrap_or("").to_string(),
    )];
    if let Some(connections) = desktop["connections"].as_array() {
        for connection in connections {
            if let (Some(id), Some(name)) = (connection["id"].as_str(), connection["name"].as_str())
            {
                remaining.push((id.into(), name.into()));
            }
        }
    }
    let mut choices = Vec::new();
    if let Some(order) = desktop["instanceOrder"].as_array() {
        for id in order.iter().filter_map(|id| id.as_str()) {
            if let Some(index) = remaining.iter().position(|(known, _)| known == id) {
                choices.push(remaining.remove(index));
            }
        }
    }
    choices.extend(remaining);
    choices
}
pub fn update_instances(app: &tauri::AppHandle, config: &serde_json::Value) -> Result<(), String> {
    let choices = instance_choices(config);
    let state = app.state::<Instances>();
    let shortcuts = instance_shortcuts(app);
    {
        let mut current = state.choices.lock().unwrap();
        let mut current_shortcuts = state.shortcuts.lock().unwrap();
        if *current == choices && *current_shortcuts == shortcuts {
            return Ok(());
        }
        *current = choices.clone();
        *current_shortcuts = shortcuts;
    }
    {
        let mut selected = state.selected.lock().unwrap();
        if !choices.iter().any(|(id, _)| id == &*selected) {
            *selected = "local".into();
        }
    }
    render_instances(app).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn tray_instance(app: tauri::AppHandle, id: Option<String>) -> Result<String, String> {
    let state = app.state::<Instances>();
    if let Some(id) = id {
        if !state
            .choices
            .lock()
            .unwrap()
            .iter()
            .any(|(candidate, _)| candidate == &id)
        {
            return Err("Unknown instance".into());
        }
        *state.selected.lock().unwrap() = id;
        render_instances(&app).map_err(|e| e.to_string())?;
    }
    let selected = state.selected.lock().unwrap().clone();
    Ok(selected)
}
#[tauri::command]
pub fn take_instance_request(state: tauri::State<'_, Instances>) -> Option<String> {
    state.requested.lock().unwrap().take()
}

pub(crate) fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open = crate::keybindings::item(app.handle(), "trayOpen", "native.openTrawl")?;
    let server = crate::keybindings::item(app.handle(), "trayServer", "ui.startLocalServer")?;
    let restart = crate::keybindings::item(app.handle(), "trayRestart", "ui.restartLocalServer")?;
    restart.set_enabled(false)?;
    let instances = Submenu::new(app, "Instance: Local instance", true)?;
    *app.state::<Instances>().menu.lock().unwrap() = Some(instances.clone());
    render_instances(app.handle())?;
    let settings = crate::keybindings::item(app.handle(), "connections", "ui.appSettings")?;
    let server_settings = crate::keybindings::item(app.handle(), "settings", "ui.serverSettings")?;
    let quit = crate::keybindings::item(app.handle(), "quit", "native.quitTrawl")?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &instances,
            &server,
            &restart,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &server_settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    crate::keybindings::track_menu(app.handle(), &menu)?;
    let revision = Arc::new(AtomicU64::new(0));
    let running = Arc::new(AtomicBool::new(false));
    let pending = revision.clone();
    let observed = running.clone();
    let source = app
        .default_window_icon()
        .ok_or("Missing application icon")?;
    let colored = Image::new_owned(source.rgba().to_vec(), source.width(), source.height());
    let icon = Arc::new(StatusIcon {
        stopped: stopped_icon(&colored),
        colored,
        running: AtomicBool::new(false),
    });
    let observed_icon = icon.clone();
    TrayIconBuilder::with_id("main")
        .icon(icon.stopped.clone())
        .tooltip("TRAWL")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            if app
                .state::<crate::keybindings::Keybindings>()
                .recording
                .load(Ordering::SeqCst)
            {
                return;
            }
            if let Some(id) = event.id.as_ref().strip_prefix("instance:") {
                let state = app.state::<Instances>();
                let renderer_ready =
                    app.get_webview_window("main").is_some() && crate::window_chrome::ready(app);
                if let Ok(notify) = state.request(id, renderer_ready) {
                    // Keep the old checkmark until the renderer accepts discarding any edits.
                    let _ = render_instances(app);
                    if notify {
                        let _ = app.emit("instance-requested", ());
                    }
                }
                return;
            }
            let action = crate::keybindings::action(app, event.id.as_ref()).unwrap_or_default();
            match action.as_str() {
                "trayOpen" => crate::open_main(app),
                "trayServer" | "trayRestart" => {
                    if !is_local(app) {
                        return;
                    }
                    let Some(item) = crate::keybindings::get(app, "trayServer") else {
                        return;
                    };
                    let Some(restart_item) = crate::keybindings::get(app, "trayRestart") else {
                        return;
                    };
                    let restarting = action == "trayRestart";
                    let current = pending.load(Ordering::SeqCst);
                    if current % 2 != 0
                        || pending
                            .compare_exchange(
                                current,
                                current.wrapping_add(1),
                                Ordering::SeqCst,
                                Ordering::SeqCst,
                            )
                            .is_err()
                    {
                        return;
                    }
                    let enabled = !observed.load(Ordering::SeqCst);
                    let _ = item.set_enabled(false);
                    let _ = restart_item.set_enabled(false);
                    crate::keybindings::set_label(
                        app,
                        "trayServer",
                        if restarting {
                            "native.serverRestarting"
                        } else if enabled {
                            "native.serverStarting"
                        } else {
                            "native.serverStopping"
                        },
                    );
                    let app = app.clone();
                    let item = item.clone();
                    let restart_item = restart_item.clone();
                    let pending = pending.clone();
                    let observed = observed.clone();
                    let icon = observed_icon.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<Arc<AppState>>().inner().clone();
                        let result = if restarting {
                            match runtime::call(&state, serde_json::json!({"action":"stop"})).await
                            {
                                Ok(_) => runtime::start(&state).await.map(|_| ()),
                                Err(error) => Err(error),
                            }
                        } else if enabled {
                            runtime::start(&state).await.map(|_| ())
                        } else {
                            runtime::call(&state, serde_json::json!({"action":"stop"}))
                                .await
                                .map(|_| ())
                        };
                        if let Err(error) = result {
                            if let Ok(mut saved) = state.startup_error.lock() {
                                *saved = Some(error.clone());
                            }
                            crate::open_main(&app);
                            let _ = app.emit("runtime-error", error);
                        }
                        if let Ok(status) = runtime::local_status(&state).await {
                            observed.store(status["running"] == true, Ordering::SeqCst);
                        }
                        let running = observed.load(Ordering::SeqCst);
                        icon.update(&app, running);
                        crate::keybindings::set_label(
                            &app,
                            "trayServer",
                            if running {
                                "ui.stopLocalServer"
                            } else {
                                "ui.startLocalServer"
                            },
                        );
                        let _ = restart_item.set_enabled(running);
                        let _ = item.set_enabled(true);
                        pending.fetch_add(1, Ordering::SeqCst);
                    });
                }
                _ => {}
            }
        })
        .build(app)?;
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<AppState>>().inner().clone();
        while !state.quitting.load(Ordering::SeqCst) {
            let _ = crate::i18n::refresh_app_language(app.clone());
            let current = revision.load(Ordering::SeqCst);
            if current % 2 == 0 {
                if let Ok(status) = runtime::local_status(&state).await {
                    if revision.load(Ordering::SeqCst) == current {
                        running.store(status["running"] == true, Ordering::SeqCst);
                        let is_running = status["running"] == true;
                        icon.update(&app, is_running);
                        let Some(server) = crate::keybindings::get(&app, "trayServer") else {
                            break;
                        };
                        let Some(restart) = crate::keybindings::get(&app, "trayRestart") else {
                            break;
                        };
                        let local = is_local(&app);
                        crate::keybindings::set_label(
                            &app,
                            "trayServer",
                            if !local {
                                "native.serverManaged"
                            } else if is_running {
                                "ui.stopLocalServer"
                            } else {
                                "ui.startLocalServer"
                            },
                        );
                        let _ = server.set_enabled(local);
                        let _ = restart.set_enabled(local && is_running);
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instances() -> Instances {
        let state = Instances::default();
        state
            .choices
            .lock()
            .unwrap()
            .push(("remote".into(), "Remote fixture".into()));
        state
    }

    #[test]
    fn closed_window_selection_is_committed_without_a_renderer_request() {
        let state = instances();
        assert!(!state.request("remote", false).unwrap());
        assert_eq!(*state.selected.lock().unwrap(), "remote");
        assert_eq!(*state.requested.lock().unwrap(), None);
    }

    #[test]
    fn live_window_selection_waits_for_the_unsaved_edits_guard() {
        let state = instances();
        assert!(state.request("remote", true).unwrap());
        assert_eq!(*state.selected.lock().unwrap(), "local");
        assert_eq!(*state.requested.lock().unwrap(), Some("remote".into()));
        assert!(state.request("unknown", false).is_err());
        assert_eq!(*state.selected.lock().unwrap(), "local");
    }

    #[test]
    fn stopped_status_icon_preserves_transparent_logo_pixels() {
        let image = Image::new_owned(vec![0, 255, 0, 123, 12, 34, 56, 0], 2, 1);
        let stopped = stopped_icon(&image);
        assert_eq!(stopped.rgba(), &[149, 149, 149, 123, 29, 29, 29, 0]);
        assert_eq!((stopped.width(), stopped.height()), (2, 1));
    }
}

#[cfg(test)]
mod instance_tests {
    #[test]
    fn tray_names_and_numbered_positions_follow_saved_order() {
        let config = serde_json::json!({"desktop": {
            "localName": "My Mac", "instanceOrder": ["remote", "missing", "local", "remote"],
            "connections": [{"id": "remote", "name": "Home"}, {"id": "other", "name": "Lab"}]
        }});
        assert_eq!(
            super::instance_choices(&config),
            vec![
                ("remote".into(), "Home".into()),
                ("local".into(), "My Mac".into()),
                ("other".into(), "Lab".into())
            ]
        );
    }
}
