use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Manager,
};
use tauri_plugin_notification::NotificationExt;
use trawl_mobile_runtime::Runtime;
#[path = "mobile_bridge.rs"]
pub(crate) mod bridge;

pub struct AppState {
    pub home: std::path::PathBuf,
    pub http: reqwest::Client,
    pub operations: crate::operations::Operations,
    pub streams: crate::streams::Streams,
    pub client_jobs: AtomicUsize,
    selected: Mutex<String>,
}
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static QUITTING: AtomicBool = AtomicBool::new(false);
static CORE: Mutex<Option<Arc<Runtime>>> = Mutex::new(None);
static SERVICE_JOBS: AtomicUsize = AtomicUsize::new(0);
static SYNC_STARTED: AtomicBool = AtomicBool::new(false);
fn core_for(home: std::path::PathBuf) -> Result<Arc<Runtime>, String> {
    let mut saved = CORE.lock().unwrap();
    if let Some(core) = saved.as_ref() {
        return Ok(core.clone());
    }
    let browser: trawl_mobile_runtime::Browser = Arc::new(move |value| {
        Box::pin(async move {
            struct Cancel(Option<String>);
            impl Drop for Cancel {
                fn drop(&mut self) {
                    if let Some(id) = self.0.take() {
                        tauri::async_runtime::spawn(async move {
                            let _ = bridge::call("cancelBrowser", json!({"requestId":id})).await;
                        });
                    }
                }
            }
            let mut cancel = Cancel(value["requestId"].as_str().map(str::to_owned));
            let result = bridge::call("browser", value)
                .await
                .map_err(|e| format!("Android browser failed: {e}"));
            cancel.0 = None;
            result
        })
    });
    let core = Runtime::new(home, Some(browser), Arc::new(|_| {}))?;
    *saved = Some(core.clone());
    Ok(core)
}
fn start_sync(core: Arc<Runtime>) {
    if SYNC_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            let mut value = core.summary();
            value["active"] = json!(
                value["active"].as_u64().unwrap_or(0) + SERVICE_JOBS.load(Ordering::SeqCst) as u64
            );
            let _ = bridge::call("setState", value).await;
        }
    });
}
#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn Java_com_germondai_trawl_mobile_RuntimeService_nativeRestore(
    mut env: jni::EnvUnowned,
    _: jni::objects::JObject,
    home: jni::objects::JString,
    wanted: jni::sys::jboolean,
) {
    let Some(home) = env
        .with_env(|env| home.try_to_string(env).map(Some))
        .resolve::<jni::errors::LogErrorAndDefault>()
    else {
        return;
    };
    let core = core_for(home.into());
    tauri::async_runtime::spawn(async move {
        match core {
            Ok(core) => {
                if wanted {
                    if let Err(error) = core.start(None).await {
                        let _ = bridge::call("runtimeFailure", json!({"message":error})).await;
                    }
                }
                start_sync(core);
            }
            Err(error) => {
                let _ = bridge::call("runtimeFailure", json!({"message":error})).await;
            }
        }
    });
}
fn plugin() -> TauriPlugin<tauri::Wry> {
    PluginBuilder::new("trawl-runtime")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.germondai.trawl.mobile", "RuntimePlugin")?;
            app.manage(handle);
            Ok(())
        })
        .build()
}
async fn call(_app: &tauri::AppHandle, method: &str, args: Value) -> Result<Value, String> {
    bridge::call(method, args).await
}
pub async fn ensure_service(app: &tauri::AppHandle) -> Result<(), String> {
    static PERMISSION: tokio::sync::Mutex<bool> = tokio::sync::Mutex::const_new(false);
    let mut requested = PERMISSION.lock().await;
    if !*requested {
        let handle = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            handle.notification().request_permission()
        })
        .await;
        *requested = true;
    }
    drop(requested);
    call(app, "ensureService", json!({})).await?;
    Ok(())
}
pub fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    let app = app.clone();
    let args = json!({"title":title,"body":body});
    tauri::async_runtime::spawn(async move {
        let _ = call(&app, "notifyTask", args).await;
    });
}
#[tauri::command]
async fn server_start(app: tauri::AppHandle) -> Result<Value, String> {
    ensure_service(&app).await?;
    service_request(json!({"action":"start"})).await
}
pub(crate) async fn sync_state(app: &tauri::AppHandle) {
    static SYNC: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _sync = SYNC.lock().await;
    let active = app
        .state::<Arc<AppState>>()
        .client_jobs
        .load(Ordering::SeqCst);
    let _ = service_request(json!({"action":"clientJobs","active":active})).await;
}
pub(crate) async fn service_request(request: Value) -> Result<Value, String> {
    let mut response = bridge::call("runtime", request).await?;
    Ok(response["value"].take())
}
#[tauri::command]
async fn instance_status() -> Result<Value, String> {
    service_request(json!({"action":"status"})).await
}
#[tauri::command]
async fn management(app: tauri::AppHandle, request: Value) -> Result<Value, String> {
    if !matches!(
        request["action"].as_str(),
        Some(
            "bootstrap"
                | "config"
                | "saveConfig"
                | "status"
                | "start"
                | "stop"
                | "stopOwned"
                | "browserStatus"
                | "clearStorage"
                | "logs"
                | "installBrowser"
                | "repairBrowser"
                | "activateBrowser"
                | "uninstallBrowser"
                | "discardBrowserDownload"
        )
    ) {
        return Err("This management operation is unavailable on Android".into());
    }
    if request["action"] == "start" {
        ensure_service(&app).await?;
    }
    service_request(request).await
}
async fn service_management(core: &Arc<Runtime>, request: Value) -> Result<Value, String> {
    let action = request["action"].as_str().ok_or("Missing action")?;
    let result = match action {
        "bootstrap" => {
            let config=core.public_config(); let mut effective=config["env"].clone(); effective["API_KEY"]=json!("[redacted]");
            Ok(json!({"config":config,"effective":effective,"inherited":{},"sources":{},"catalog":core.catalog(),"status":core.status(),"browser":browser()}))
        },
        "config" => Ok(json!({"config":core.public_config()})),
        "saveConfig" => core.save(request["config"].clone()),
        "status" => Ok(core.status()),
        "start" => core.start(None).await,
        "stop"|"stopOwned" => core.stop().await,
        "browserStatus" => Ok(browser()),
        "clearStorage" => core.clear(request["storage"].as_str().unwrap_or("")),
        "logs" => Ok(json!(core.log_text())),
        "resources" => bridge::call("resources",json!({})).await,
        "connection" => Ok(json!({"config":core.config(),"status":core.status()})),
        "clientJobs" => { SERVICE_JOBS.store(request["active"].as_u64().unwrap_or(0).min(64) as usize,Ordering::SeqCst); Ok(Value::Null) },
        "installBrowser"|"repairBrowser"|"activateBrowser"|"uninstallBrowser"|"discardBrowserDownload" => Err("Android uses the System WebView managed by Android; desktop Camoufox installations are unavailable".into()),
        _ => Err("This management operation is unavailable on Android".into())
    };
    if result.is_ok() && matches!(action, "start" | "stop" | "stopOwned") {
        bridge::call("serverIntent", json!({"running":action=="start"})).await?;
    }
    let mut summary = core.summary();
    summary["active"] =
        json!(summary["active"].as_u64().unwrap_or(0) + SERVICE_JOBS.load(Ordering::SeqCst) as u64);
    let _ = bridge::call("setState", summary).await;
    result
}
#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn Java_com_germondai_trawl_mobile_RuntimeService_nativeManagement(
    mut env: jni::EnvUnowned,
    _: jni::objects::JObject,
    id: i32,
    request: jni::objects::JString,
) {
    let Some(request) = env
        .with_env(|env| request.try_to_string(env).map(Some))
        .resolve::<jni::errors::LogErrorAndDefault>()
    else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let result = match serde_json::from_str::<Value>(&request) {
            Ok(request) => {
                let core = CORE.lock().unwrap().clone();
                match core {
                    Some(core) => service_management(&core, request).await,
                    None => Err("Background runtime is not ready".into()),
                }
            }
            Err(_) => Err("Invalid runtime request".into()),
        };
        let payload = match result {
            Ok(value) => json!({"id":id,"ok":true,"value":value}),
            Err(error) => json!({"id":id,"ok":false,"message":error}),
        };
        let _ = bridge::call("runtimeReply", payload).await;
    });
}
fn browser() -> Value {
    json!({"installed":true,"system":true,"state":"ready","version":"Android System WebView","choices":[]})
}
#[tauri::command]
async fn resource_usage() -> Result<Value, String> {
    service_request(json!({"action":"resources"})).await
}
#[tauri::command]
async fn live_activity_status(app: tauri::AppHandle) -> Result<Value, String> {
    call(&app, "liveActivityStatus", json!({})).await
}
pub(super) async fn interaction_haptic(
    app: &tauri::AppHandle,
    feedback: crate::InteractionFeedback,
) -> Result<(), String> {
    let feedback = match feedback {
        crate::InteractionFeedback::Press => "press",
        crate::InteractionFeedback::Navigate => "navigate",
        crate::InteractionFeedback::Success => "success",
        crate::InteractionFeedback::Error => "error",
    };
    call(app, "interactionHaptic", json!({"feedback": feedback})).await?;
    Ok(())
}
pub async fn app_locale(app: &tauri::AppHandle) -> Result<String, String> {
    let value = call(app, "appLocale", json!({})).await?;
    Ok(value["locale"].as_str().unwrap_or("en").to_owned())
}
#[tauri::command]
async fn reveal_storage(app: tauri::AppHandle, _name: Option<String>) -> Result<(), String> {
    call(&app, "storageSettings", json!({})).await?;
    Ok(())
}
#[tauri::command]
async fn open_connection_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = reqwest::Url::parse(&url).map_err(|_| "Invalid connection URL")?;
    if !["http", "https"].contains(&target.scheme())
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err("Use an HTTP(S) URL without credentials".into());
    }
    call(&app, "openUrl", json!({"url":url})).await?;
    Ok(())
}
#[tauri::command]
fn tray_instance(state: tauri::State<'_, Arc<AppState>>, id: Option<String>) -> String {
    let mut selected = state.selected.lock().unwrap();
    if let Some(id) = id {
        *selected = id;
    }
    selected.clone()
}
#[tauri::command]
fn take_page_request() -> Option<String> {
    None
}
#[tauri::command]
fn take_instance_request() -> Option<String> {
    None
}
#[tauri::command]
async fn close_window(app: tauri::AppHandle, behavior: String) -> Result<(), String> {
    if behavior == "quit" {
        service_request(json!({"action":"stop"})).await?;
        call(&app, "shutdown", json!({})).await?;
        QUITTING.store(true, Ordering::SeqCst);
        app.exit(0);
    } else {
        call(&app, "minimize", json!({})).await?;
    }
    Ok(())
}
#[tauri::command]
fn cancel_quit_gesture() {}
#[tauri::command]
fn set_shortcut_recording(_enabled: bool) {}
#[tauri::command]
async fn set_android_page_back(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    call(&app, "pageBack", json!({"enabled": enabled})).await?;
    Ok(())
}
#[tauri::command]
async fn enable_notifications(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let _ =
        tauri::async_runtime::spawn_blocking(move || handle.notification().request_permission())
            .await;
    Ok(())
}
#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn Java_com_germondai_trawl_mobile_RuntimeService_nativeAction(
    mut env: jni::EnvUnowned,
    _this: jni::objects::JObject,
    action: jni::objects::JString,
) -> jni::sys::jboolean {
    let Some(core) = CORE.lock().unwrap().clone() else {
        return false;
    };
    let Some(action) = env
        .with_env(|env| action.try_to_string(env).map(Some))
        .resolve::<jni::errors::LogErrorAndDefault>()
    else {
        return false;
    };
    tauri::async_runtime::spawn(async move {
        let result = match action.as_str() {
            "stop" => core.stop().await,
            "restart" => match core.stop().await {
                Ok(_) => core.start(None).await,
                Err(error) => Err(error),
            },
            _ => Err("Unknown server action".into()),
        };
        if result.is_ok() {
            let _ = bridge::call("serverIntent", json!({"running":action != "stop"})).await;
        }
        let _ = bridge::call("setState", core.summary()).await;
        let _ = bridge::call(
            "actionFeedback",
            json!({"action":action,"success":result.is_ok()}),
        )
        .await;
    });
    true
}
#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn Java_com_germondai_trawl_desktop_MainActivity_nativeResume(
    _env: jni::EnvUnowned,
    _this: jni::objects::JObject,
) {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !QUITTING.load(Ordering::SeqCst) && handle.get_webview_window("main").is_none() {
            if let Some(config) = handle.config().app.windows.first() {
                if let Err(error) = tauri::WebviewWindowBuilder::from_config(&handle, config)
                    .and_then(|builder| builder.build())
                {
                    eprintln!("Could not restore Android window: {error}");
                }
            }
        }
    });
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(plugin())
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            let home = app.path().app_data_dir()?;
            app.manage(Arc::new(AppState {
                home,
                http: crate::http_client_builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()?,
                operations: crate::operations::Operations::default(),
                streams: crate::streams::Streams::default(),
                client_jobs: AtomicUsize::new(0),
                selected: Mutex::new("local".into()),
            }));
            tauri::async_runtime::spawn(async move {
                if let Ok(config) = service_request(json!({"action":"config"})).await {
                    if config["config"]["desktop"]["startServerOnLaunch"] == true {
                        let _ = server_start(handle).await;
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::app_locale,
            crate::interaction_haptic,
            crate::updates::check_app_update,
            crate::updates::install_app_update,
            management,
            server_start,
            instance_status,
            resource_usage,
            live_activity_status,
            reveal_storage,
            open_connection_url,
            tray_instance,
            take_page_request,
            take_instance_request,
            close_window,
            cancel_quit_gesture,
            set_shortcut_recording,
            set_android_page_back,
            enable_notifications,
            crate::runtime::api_request,
            crate::operations::api_operation,
            crate::operations::api_operation_cancel,
            crate::streams::api_stream,
            crate::streams::api_stream_ack,
            crate::streams::api_stream_cancel
        ])
        .build(tauri::generate_context!())
        .expect("Could not build TRAWL Android")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst)
                    && app
                        .state::<Arc<AppState>>()
                        .client_jobs
                        .load(Ordering::SeqCst)
                        > 0
                {
                    api.prevent_exit();
                }
            }
        });
}
