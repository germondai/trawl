use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{
    plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin},
    Manager,
};
use tauri_plugin_notification::NotificationExt;
use trawl_mobile_runtime::Runtime;

pub struct AppState {
    pub home: std::path::PathBuf,
    pub http: reqwest::Client,
    pub operations: crate::operations::Operations,
    pub streams: crate::streams::Streams,
    pub core: Arc<Runtime>,
    pub plugin: PluginHandle<tauri::Wry>,
    pub client_jobs: AtomicUsize,
    selected: Mutex<String>,
}
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
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
async fn call(app: &tauri::AppHandle, method: &str, args: Value) -> Result<Value, String> {
    app.state::<Arc<AppState>>()
        .plugin
        .run_mobile_plugin_async(method, args)
        .await
        .map_err(|e| format!("Android operation failed: {e}"))
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
    let result = app.state::<Arc<AppState>>().core.start(None).await;
    sync_state(&app).await;
    result
}
pub(crate) async fn sync_state(app: &tauri::AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let mut value = state.core.summary();
    value["active"] = json!(
        value["active"].as_u64().unwrap_or(0) + state.client_jobs.load(Ordering::SeqCst) as u64
    );
    let _ = call(app, "setState", value).await;
}
#[tauri::command]
async fn instance_status(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    Ok(state.core.status())
}
#[tauri::command]
async fn management(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    request: Value,
) -> Result<Value, String> {
    let action = request["action"].as_str().ok_or("Missing action")?;
    match action{
        "bootstrap"=>{let config=state.core.public_config();let mut effective=config["env"].clone();effective["API_KEY"]=json!("[redacted]");Ok(json!({"config":config,"effective":effective,"inherited":{},"sources":{},"catalog":state.core.catalog(),"status":state.core.status(),"browser":browser()}))},
        "config"=>Ok(json!({"config":state.core.public_config()})),
        "saveConfig"=>state.core.save(request["config"].clone()),
        "status"=>Ok(state.core.status()),
        "start"=>server_start(app).await,
        "stop"|"stopOwned"=>{let result=state.core.stop().await;sync_state(&app).await;result},
        "browserStatus"=>Ok(browser()),
        "clearStorage"=>state.core.clear(request["storage"].as_str().unwrap_or("")),
        "logs"=>Ok(json!(state.core.log_text())),
        "installBrowser"|"repairBrowser"|"activateBrowser"|"uninstallBrowser"|"discardBrowserDownload"=>Err("Android uses the System WebView managed by Android; desktop Camoufox installations are unavailable".into()),
        _=>Err("This management operation is unavailable on Android".into())
    }
}
fn browser() -> Value {
    json!({"installed":true,"system":true,"state":"ready","version":"Android System WebView","choices":[]})
}
#[tauri::command]
async fn resource_usage(app: tauri::AppHandle) -> Result<Value, String> {
    call(&app, "resources", json!({})).await
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
        app.state::<Arc<AppState>>().core.stop().await?;
        call(&app, "shutdown", json!({})).await?;
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
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    action: jni::objects::JString,
) -> jni::sys::jboolean {
    let Some(app) = APP.get().cloned() else {
        return 0;
    };
    let Ok(action) = env.get_string(&action) else {
        return 0;
    };
    let action: String = action.into();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<AppState>>();
        match action.as_str() {
            "stop" => {
                let _ = state.core.stop().await;
            }
            "restart" => {
                let _ = state.core.stop().await;
                let _ = state.core.start(None).await;
            }
            _ => {}
        }
        sync_state(&app).await;
    });
    1
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(plugin())
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            let home = app.path().app_data_dir()?;
            let bridge = app.state::<PluginHandle<tauri::Wry>>().inner().clone();
            let browser_bridge = bridge.clone();
            let browser: trawl_mobile_runtime::Browser = Arc::new(move |value| {
                let bridge = browser_bridge.clone();
                Box::pin(async move {
                    struct Cancel {
                        bridge: PluginHandle<tauri::Wry>,
                        id: Option<String>,
                    }
                    impl Drop for Cancel {
                        fn drop(&mut self) {
                            if let Some(id) = self.id.take() {
                                let bridge = self.bridge.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _ = bridge
                                        .run_mobile_plugin_async::<Value>(
                                            "cancelBrowser",
                                            json!({"requestId":id}),
                                        )
                                        .await;
                                });
                            }
                        }
                    }
                    let mut cancel = Cancel {
                        bridge: bridge.clone(),
                        id: value["requestId"].as_str().map(str::to_owned),
                    };
                    let result = bridge
                        .run_mobile_plugin_async::<Value>("browser", value)
                        .await
                        .map_err(|e| format!("Android browser failed: {e}"));
                    cancel.id = None;
                    result
                })
            });
            let core = Runtime::new(home.clone(), Some(browser), Arc::new(|_| {}))
                .map_err(std::io::Error::other)?;
            let start = core.config()["desktop"]["startServerOnLaunch"] == true;
            app.manage(Arc::new(AppState {
                home,
                http: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()?,
                operations: crate::operations::Operations::default(),
                streams: crate::streams::Streams::default(),
                core,
                plugin: bridge,
                client_jobs: AtomicUsize::new(0),
                selected: Mutex::new("local".into()),
            }));
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                if start {
                    let _ = server_start(handle.clone()).await;
                }
                loop {
                    interval.tick().await;
                    sync_state(&handle).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            management,
            server_start,
            instance_status,
            resource_usage,
            reveal_storage,
            open_connection_url,
            tray_instance,
            take_page_request,
            take_instance_request,
            close_window,
            cancel_quit_gesture,
            set_shortcut_recording,
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
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                let state = app.state::<Arc<AppState>>();
                if state.core.status()["running"] == true
                    || state.client_jobs.load(Ordering::SeqCst) > 0
                {
                    api.prevent_exit();
                }
            }
        });
}
