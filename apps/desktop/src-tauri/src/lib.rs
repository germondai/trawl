mod operations;
mod runtime;
mod streams;
mod window_chrome;
#[cfg(target_os = "macos")]
mod window_state;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::Mutex;

pub struct AppState {
    runtime: std::path::PathBuf,
    home: std::path::PathBuf,
    child: Mutex<Option<tokio::process::Child>>,
    quitting: AtomicBool,
    close_behavior: AtomicU8,
    http: reqwest::Client,
    streams: streams::Streams,
    operations: operations::Operations,
    startup_error: std::sync::Mutex<Option<String>>,
}
fn open_main(app: &tauri::AppHandle) {
    let app = app.clone();
    let dispatcher = app.clone();
    let _ = dispatcher.run_on_main_thread(move || {
        if app.state::<Arc<AppState>>().quitting.load(Ordering::SeqCst) {
            return;
        }
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
                close_behavior: AtomicU8::new(0),
                startup_error: std::sync::Mutex::new(None),
                streams: streams::Streams::default(),
                operations: operations::Operations::default(),
                http: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(std::time::Duration::from_secs(10))
                    .build()?,
            }));
            let open = MenuItem::with_id(app, "open", "Open TRAWL", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "Start local server", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop local server", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit TRAWL", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&open, &start, &stop, &quit_item])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .ok_or("Missing application icon")?
                        .clone(),
                )
                .tooltip("TRAWL scraping server")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => open_main(app),
                    "quit" => request_quit(app),
                    "start" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<Arc<AppState>>().inner().clone();
                            if let Err(error) = runtime::start(&state).await {
                                let _ = app.emit("runtime-error", error);
                            }
                        });
                    }
                    "stop" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<Arc<AppState>>().inner().clone();
                            if let Err(error) =
                                runtime::call(&state, serde_json::json!({"action":"stop"})).await
                            {
                                let _ = app.emit("runtime-error", error);
                            }
                        });
                    }
                    _ => {}
                })
                .build(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<Arc<AppState>>().inner().clone();
                let result = async {
                    let initial =
                        runtime::call(&state, serde_json::json!({"action":"config"})).await?;
                    runtime::update_behavior(&state, &initial["config"]);
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
                tauri::WindowEvent::Destroyed => {
                    app.state::<Arc<AppState>>().streams.cancel_all();
                    app.state::<Arc<AppState>>().operations.cancel_all();
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
        .invoke_handler(tauri::generate_handler![
            runtime::management,
            runtime::server_start,
            runtime::api_request,
            operations::api_operation,
            operations::api_operation_cancel,
            streams::api_stream,
            streams::api_stream_ack,
            streams::api_stream_cancel,
            runtime::instance_status,
            close_window,
            window_chrome::native_window_document,
            window_chrome::native_window_chrome,
            window_chrome::native_window_ready
        ])
        .build(tauri::generate_context!())
        .expect("Could not initialize TRAWL desktop")
        .run(|app, event| match event {
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
