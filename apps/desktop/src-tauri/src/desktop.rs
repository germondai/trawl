#[tauri::command]
async fn enable_notifications(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    tauri::async_runtime::spawn_blocking(move || app.notification().request_permission()).await.map_err(|_| "Could not request notification permission")?.map_err(|e|e.to_string())?;
    Ok(())
}
#[tauri::command]
fn cancel_quit_gesture(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    shortcuts::cancel_gesture(&app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
mod keybindings;
#[cfg(target_os = "macos")]
mod history_gesture;
mod operations;
mod resources;
mod runtime;
#[cfg(target_os = "macos")]
mod shortcuts;
mod streams;
mod tray;
mod window_chrome;
#[cfg(target_os = "macos")]
mod window_state;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::Mutex;

pub struct AppState {
    runtime: std::path::PathBuf,
    home: std::path::PathBuf,
    child: Mutex<Option<tokio::process::Child>>,
    quitting: AtomicBool,
    close_behavior: AtomicU8,
    #[cfg(target_os = "macos")]
    quit_behavior: AtomicU8,
    #[cfg(target_os = "macos")]
    app_visibility: AtomicU8,
    http: reqwest::Client,
    streams: streams::Streams,
    operations: operations::Operations,
    browser_operations: operations::Operations,
    startup_error: std::sync::Mutex<Option<String>>,
    requested_page: AtomicU8,
}
fn open_main(app: &tauri::AppHandle) {
    let app = app.clone();
    let dispatcher = app.clone();
    let _ = dispatcher.run_on_main_thread(move || {
        if app.state::<Arc<AppState>>().quitting.load(Ordering::SeqCst) {
            return;
        }
        #[cfg(target_os = "macos")]
        runtime::window_dock_visibility(&app, true);
        if let Some(window) = app.get_webview_window("main") {
            window_chrome::reopen(&window);
        } else if let Some(config) = app.config().app.windows.first() {
            match tauri::WebviewWindowBuilder::from_config(&app, config)
                .and_then(|builder| builder.build())
            {
                Ok(window) => {
                    if let Err(error) = window_chrome::setup(&window) {
                        eprintln!("Cannot prepare window: {error}");
                    }
                }
                Err(error) => eprintln!("Cannot open TRAWL: {error}"),
            }
        }
    });
}
const NAVIGATION_PAGES: [&str; 14] = [
    "connections",
    "settings",
    "overview",
    "history",
    "sessions",
    "browser",
    "resources",
    "logs",
    "workbench",
    "sidebar",
    "refresh",
    "search",
    "server",
    "restart",
];
fn request_page(app: &tauri::AppHandle, page: &str) {
    let Some(index) = NAVIGATION_PAGES
        .iter()
        .position(|candidate| *candidate == page)
    else {
        return;
    };
    app.state::<Arc<AppState>>()
        .requested_page
        .store(index as u8 + 1, Ordering::SeqCst);
    open_main(app);
    let _ = app.emit("page-requested", page);
}
#[tauri::command]
fn take_page_request(state: tauri::State<'_, Arc<AppState>>) -> Option<String> {
    let index = state.requested_page.swap(0, Ordering::SeqCst);
    index
        .checked_sub(1)
        .and_then(|index| NAVIGATION_PAGES.get(index as usize))
        .map(|page| page.to_string())
}
fn request_quit(app: &tauri::AppHandle) {
    if let Some(window) = app
        .get_webview_window("main")
        .filter(|_| window_chrome::ready(app))
    {
        let _ = window.emit("close-requested", "quit");
        open_main(app);
    } else {
        quit(app.clone());
    }
}
fn quit(app: tauri::AppHandle) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    state.streams.cancel_all();
    state.operations.cancel_all();
    state.browser_operations.cancel_all();
    tauri::async_runtime::spawn(async move {
        let _ = runtime::stop_owned(&state).await;
        app.exit(0);
    });
}
#[tauri::command]
async fn close_window(app: tauri::AppHandle, behavior: String) -> Result<(), String> {
    match behavior.as_str() {
        "tray" => {
            if let Some(window) = app.get_webview_window("main") {
                window.destroy().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        "quit" => {
            quit(app);
            Ok(())
        }
        _ => Err("Invalid close behavior".into()),
    }
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(keybindings::Keybindings::default())
        .manage(tray::Instances::default())
        .menu(keybindings::menu)
        .on_menu_event(|app, event| {
            if let Some(action) = keybindings::action(app, event.id.as_ref()) {
                if app.state::<keybindings::Keybindings>().recording.load(Ordering::SeqCst) {
                    let _ = app.emit("shortcut-recorded", serde_json::json!({"shortcut":keybindings::binding(app, &action),"cancel":false}));
                    return;
                }
                match action.as_str() {
                    "quit" => request_quit(app),
                    "close" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.close();
                        }
                    }
                    action => request_page(app, action),
                }
            }
        })
        .manage(window_chrome::WindowChrome::default())
        .on_page_load(|webview, payload| {
            if webview.label() != "main"
                || webview.app_handle().try_state::<Arc<AppState>>().is_none()
            {
                return;
            }
            let Some(window) = webview.app_handle().get_webview_window("main") else {
                return;
            };
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => window_chrome::loading(&window),
                tauri::webview::PageLoadEvent::Finished => window_chrome::loaded(&window),
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|arg| arg == "--background") {
                open_main(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                objc2_foundation::NSProcessInfo::processInfo()
                    .setProcessName(&objc2_foundation::NSString::from_str("TRAWL"));
                shortcuts::setup(app.handle().clone());
            }
            let packaged = app.path().resource_dir()?.join("runtime");
            let root = if cfg!(debug_assertions) && !packaged.is_dir() {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../.artifacts/v2/runtime")
            } else {
                app.path().resource_dir()?.join("runtime")
            };
            let data = if cfg!(target_os = "windows") {
                app.path().local_data_dir()?
            } else {
                app.path().data_dir()?
            };
            let home = std::env::var_os("TRAWL_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    data.join(if cfg!(target_os = "linux") {
                        "trawl"
                    } else {
                        "TRAWL"
                    })
                });
            let home = if home.is_absolute() {
                home
            } else {
                std::env::current_dir()?.join(home)
            };
            app.manage(Arc::new(AppState {
                runtime: root,
                home,
                child: Mutex::new(None),
                quitting: AtomicBool::new(false),
                close_behavior: AtomicU8::new(1),
                #[cfg(target_os = "macos")]
                quit_behavior: AtomicU8::new(2),
                #[cfg(target_os = "macos")]
                app_visibility: AtomicU8::new(0),
                startup_error: std::sync::Mutex::new(None),
                requested_page: AtomicU8::new(0),
                streams: streams::Streams::default(),
                operations: operations::Operations::default(),
                browser_operations: operations::Operations::default(),
                http: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(std::time::Duration::from_secs(10))
                    .build()?,
            }));
            tray::setup(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<Arc<AppState>>().inner().clone();
                let result = async {
                    let initial =
                        runtime::call(&state, serde_json::json!({"action":"config"})).await?;
                    runtime::update_behavior(&handle, &state, &initial["config"])?;
                    if initial["config"]["desktop"]["startServerOnLaunch"] == true {
                        runtime::start(&state).await?;
                    }
                    Ok::<(), String>(())
                }
                .await;
                if let Err(error) = result {
                    if let Ok(mut saved) = state.startup_error.lock() {
                        *saved = Some(error.clone());
                    }
                    if !std::env::args().any(|arg| arg == "--background") {
                        open_main(&handle);
                    }
                    let _ = handle.emit("runtime-error", error);
                }
            });
            if !std::env::args().any(|arg| arg == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    window_chrome::setup(&window)?;
                }
            }
            if std::env::args().any(|arg| arg == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    window.destroy()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let app = window.app_handle();
            match event {
                #[cfg(target_os = "macos")]
                tauri::WindowEvent::Focused(false) => {
                    app.state::<keybindings::Keybindings>().recording.store(false, Ordering::SeqCst);
                    shortcuts::cancel(app);
                },
                tauri::WindowEvent::Destroyed => {
                    #[cfg(target_os = "macos")]
                    runtime::window_dock_visibility(app, false);
                    app.state::<keybindings::Keybindings>().recording.store(false, Ordering::SeqCst);
                    app.state::<Arc<AppState>>().streams.cancel_all();
                    app.state::<Arc<AppState>>().operations.cancel_all();
                    app.state::<Arc<AppState>>().browser_operations.cancel_all();
                    window_chrome::destroyed(app);
                }
                tauri::WindowEvent::Resized(_) => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window_chrome::update(&window);
                    }
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let state = app.state::<Arc<AppState>>();
                    if !window_chrome::ready(app) {
                        quit(app.clone());
                        return;
                    }
                    let behavior = match state.close_behavior.load(Ordering::SeqCst) {
                        1 => "tray",
                        2 => "quit",
                        _ => "ask",
                    };
                    let _ = window.emit("close-requested", behavior);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![crate::app_locale, crate::i18n::refresh_app_language, crate::updates::check_app_update, crate::updates::install_app_update, crate::updates::app_update_download_status, enable_notifications,
            crate::setting_paths::choose_setting_path,
            cancel_quit_gesture,
            runtime::management,
            runtime::open_connection_url,
            runtime::management_progress,
            runtime::browser_operation,
            runtime::browser_operation_cancel,
            runtime::server_start,
            runtime::api_request,
            operations::api_operation,
            operations::api_operation_cancel,
            streams::api_stream,
            streams::api_stream_ack,
            streams::api_stream_cancel,
            runtime::instance_status,
            keybindings::set_shortcut_recording,
            tray::tray_instance,
            tray::take_instance_request,
            take_page_request,
            resources::resource_usage,
            resources::reveal_storage,
            close_window,
            window_chrome::native_window_document,
            window_chrome::native_window_drag,
            window_chrome::native_window_chrome,
            window_chrome::native_window_ready
        ])
        .build(tauri::generate_context!())
        .expect("Could not initialize TRAWL desktop")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Ready => {
                use objc2::{AllocAnyThread, MainThreadMarker};
                use objc2_app_kit::{NSApplication, NSImage};
                use objc2_foundation::NSData;
                if let Some(mtm) = MainThreadMarker::new() {
                    let data = NSData::with_bytes(include_bytes!("../icons/icon.png"));
                    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
                        // Preserve the original transparent mark instead of the OS-generated tile.
                        unsafe {
                            NSApplication::sharedApplication(mtm)
                                .setApplicationIconImage(Some(&icon));
                        }
                    }
                }
                // AppKit lays out the status button after tray creation; refresh its hit area.
                if let Some(tray) = app.tray_by_id("main") {
                    let _ = tray.set_title(None::<&str>);
                }
            }
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if !app.state::<Arc<AppState>>().quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    if code.is_some() {
                        request_quit(app);
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => open_main(app),
            _ => {}
        });
}
