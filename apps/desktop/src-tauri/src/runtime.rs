use crate::AppState;
use serde_json::{json, Value};
use std::{
    process::Stdio,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::{Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const LIMIT: u64 = 2 * 1024 * 1024;
fn executable(state: &AppState) -> std::path::PathBuf {
    state.runtime.join(if cfg!(windows) {
        "trawl-server.exe"
    } else {
        "trawl-server"
    })
}
pub async fn call(state: &AppState, request: Value) -> Result<Value, String> {
    call_progress(state, request, None, None).await
}
async fn read_progress(
    mut stderr: Option<tokio::process::ChildStderr>,
    channel: Option<tauri::ipc::Channel<Value>>,
) -> Result<(), String> {
    let Some(stderr) = stderr.as_mut() else {
        return Ok(());
    };
    let mut line = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        let size = stderr
            .read(&mut buffer)
            .await
            .map_err(|_| "Could not read installation progress")?;
        if size == 0 {
            return Ok(());
        }
        for byte in &buffer[..size] {
            if *byte == b'\n' {
                let value: Value =
                    serde_json::from_slice(&line).map_err(|_| "Invalid installation progress")?;
                let phase = value["phase"]
                    .as_str()
                    .filter(|phase| {
                        [
                            "checking", "copy", "download", "extract", "patch", "geoip", "addons",
                            "activate", "remove", "done",
                        ]
                        .contains(phase)
                    })
                    .ok_or("Invalid installation phase")?;
                let mut safe = json!({"phase":phase});
                for key in ["completed", "total", "elapsedMs", "etaMs"] {
                    if let Some(number) = value[key].as_u64() {
                        safe[key] = json!(number);
                    }
                }
                if let Some(unit) = value["unit"]
                    .as_str()
                    .filter(|unit| ["bytes", "files"].contains(unit))
                {
                    safe["unit"] = json!(unit);
                }
                if let Some(channel) = &channel {
                    let _ = channel.send(safe);
                }
                line.clear();
            } else {
                if line.len() >= 2048 {
                    return Err("Installation progress exceeds its budget".into());
                }
                line.push(*byte);
            }
        }
    }
}
async fn call_progress(
    state: &AppState,
    mut request: Value,
    progress: Option<tauri::ipc::Channel<Value>>,
    mut cancellation: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<Value, String> {
    let object = request
        .as_object_mut()
        .ok_or("Invalid management request")?;
    object.insert(
        "home".into(),
        Value::String(state.home.to_string_lossy().into_owned()),
    );
    let mut input = serde_json::to_vec(&request).map_err(|_| "Invalid management request")?;
    if input.len() > 1024 * 1024 {
        return Err("Management request exceeds 1 MiB".into());
    }
    input.push(b'\n');
    let deadline = if ["importBrowser", "installBrowser", "repairBrowser"]
        .contains(&request["action"].as_str().unwrap_or(""))
    {
        1800
    } else if ["stop", "stopOwned"].contains(&request["action"].as_str().unwrap_or("")) {
        shutdown_seconds(state).await + 5
    } else {
        45
    };
    let mut command = tokio::process::Command::new(executable(state));
    command
        .args(["--manage", "--watch-parent"])
        .current_dir(&state.runtime)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if progress.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .kill_on_drop(false);
    if progress.is_some() {
        command.arg("--progress");
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "The packaged runtime is missing or could not start")?;
    let mut writer = child.stdin.take().ok_or("Runtime input unavailable")?;
    if !matches!(
        tokio::time::timeout(Duration::from_secs(5), writer.write_all(&input)).await,
        Ok(Ok(()))
    ) {
        drop(writer);
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err("Could not send management request".into());
    }
    let mut stdin = Some(writer);
    let result = {
        let operation = tokio::time::timeout(Duration::from_secs(deadline), async {
            let stdout = child.stdout.take().ok_or("Runtime output unavailable")?;
            let stderr = child.stderr.take();
            let output = async {
                let mut output = Vec::new();
                stdout
                    .take(LIMIT + 1)
                    .read_to_end(&mut output)
                    .await
                    .map_err(|_| "Could not read runtime response".to_string())?;
                Ok::<_, String>(output)
            };
            let (output, ()) = tokio::try_join!(output, read_progress(stderr, progress))?;
            if output.len() as u64 > LIMIT {
                return Err("Runtime response exceeds its budget".into());
            }
            let status = child
                .wait()
                .await
                .map_err(|_| "Runtime did not exit correctly")?;
            let response: Value =
                serde_json::from_slice(&output).map_err(|_| "Invalid runtime response")?;
            if !status.success() || response["ok"] != true {
                return Err(response["error"]
                    .as_str()
                    .unwrap_or("Management operation failed")
                    .to_string());
            }
            Ok(response["result"].clone())
        });
        tokio::pin!(operation);
        tokio::select! {
          value = &mut operation => value,
          _ = async {
            if let Some(cancel) = cancellation.as_mut() {
              if !*cancel.borrow() { let _ = cancel.changed().await; }
            } else { std::future::pending::<()>().await; }
          } => {
            drop(stdin.take());
            // Drain the result: a commit completed before cancellation stays successful.
            match tokio::time::timeout(Duration::from_secs(10), &mut operation).await {
                Ok(value) => value,
                Err(_) => Ok(Err("Browser download cancelled".to_string())),
            }
          },
        }
    };
    drop(stdin);
    let value = match result {
        Ok(value) => value,
        Err(_) => Err("Runtime operation timed out and was cancelled".into()),
    };
    if value.is_err()
        && tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .is_err()
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    value
}
#[tauri::command]
pub async fn browser_operation(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    mut request: Value,
    operation_id: String,
    on_progress: tauri::ipc::Channel<Value>,
) -> Result<Value, String> {
    if !["installBrowser", "repairBrowser"].contains(&request["action"].as_str().unwrap_or(""))
        || request["browserVersion"]
            .as_str()
            .is_none_or(|version| version.len() > 80)
    {
        return Err("Choose a browser version to download".into());
    }
    request["activate"] = json!(false);
    request["resume"] = json!(true);
    let (_registration, cancellation) = state.browser_operations.register(operation_id, 3)?;
    let cancelled = cancellation.clone();
    let version = request["browserVersion"].clone();
    let result = call_progress(&state, request, Some(on_progress), Some(cancellation)).await;
    drop(_registration);
    if result.is_ok() {
        crate::notify_background(
            &app,
            &crate::i18n::format(
                "ui.camoufoxIsReady",
                &[("p0", version.as_str().unwrap_or("browser"))],
            ),
            "native.manageBrowser",
        );
    } else if !*cancelled.borrow() && !state.quitting.load(Ordering::SeqCst) {
        crate::notify_background(&app, "native.browserFailed", "native.browserRetry");
    }
    if result.is_err() && *cancelled.borrow() && !state.quitting.load(Ordering::SeqCst) {
        call(
            &state,
            json!({"action":"discardBrowserDownload", "browserVersion":version}),
        )
        .await
        .map_err(|error| format!("Could not clean cancelled download: {error}"))?;
    }
    result
}
#[tauri::command]
pub fn browser_operation_cancel(state: State<'_, Arc<AppState>>, operation_id: String) {
    state.browser_operations.cancel(&operation_id);
}
#[tauri::command]
pub async fn management(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    request: Value,
) -> Result<Value, String> {
    management_inner(app, state, request, None).await
}
#[tauri::command]
pub async fn management_progress(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    request: Value,
    on_progress: tauri::ipc::Channel<Value>,
) -> Result<Value, String> {
    if !["installBrowser", "repairBrowser", "uninstallBrowser"]
        .contains(&request["action"].as_str().unwrap_or(""))
    {
        return Err("Progress is only available for browser installation operations".into());
    }
    management_inner(app, state, request, Some(on_progress)).await
}
async fn management_inner(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    request: Value,
    on_progress: Option<tauri::ipc::Channel<Value>>,
) -> Result<Value, String> {
    let action = request["action"]
        .as_str()
        .ok_or("Missing management operation")?
        .to_string();
    if ![
        "bootstrap",
        "catalog",
        "config",
        "saveConfig",
        "profile",
        "status",
        "stop",
        "logs",
        "clearStorage",
        "browserStatus",
        "discardBrowserDownload",
        "activateBrowser",
        "installBrowser",
        "repairBrowser",
        "uninstallBrowser",
        "doctor",
    ]
    .contains(&action.as_str())
    {
        return Err("Management operation is not available to the desktop".into());
    }
    let launcher = app.autolaunch();
    let mut startup_change = None;
    if action == "saveConfig" {
        let wanted = request["config"]["desktop"]["autostart"]
            .as_bool()
            .ok_or("Invalid login startup preference")?;
        let current = launcher
            .is_enabled()
            .map_err(|_| "Cannot inspect login startup")?;
        if wanted != current {
            if wanted {
                launcher.enable()
            } else {
                launcher.disable()
            }
            .map_err(|_| "Could not update login startup; configuration was not changed")?;
            startup_change = Some(current);
        }
    }
    let progress =
        if ["installBrowser", "repairBrowser", "uninstallBrowser"].contains(&action.as_str()) {
            on_progress
        } else {
            None
        };
    let mut result = match call_progress(&state, request, progress, None).await {
        Ok(value) => value,
        Err(error) => {
            if let Some(previous) = startup_change {
                let restored = if previous {
                    launcher.enable()
                } else {
                    launcher.disable()
                };
                if restored.is_err() {
                    return Err(format!("{error}. Login startup could not be restored; check your system login settings."));
                }
            }
            return Err(error);
        }
    };
    let config = if action == "bootstrap" || action == "config" {
        &result["config"]
    } else {
        &result
    };
    update_behavior(&app, &state, config)?;
    if action == "bootstrap" {
        if let Ok(mut error) = state.startup_error.lock() {
            if let Some(error) = error.take() {
                result["startupError"] = json!(error);
            }
        }
    }
    Ok(result)
}
pub fn update_behavior(
    app: &tauri::AppHandle,
    state: &AppState,
    config: &Value,
) -> Result<(), String> {
    if let Some(behavior) = config["desktop"]["closeBehavior"].as_str() {
        state.close_behavior.store(
            match behavior {
                "tray" => 1,
                "quit" => 2,
                _ => 0,
            },
            Ordering::SeqCst,
        );
    }
    if config["desktop"].is_object() {
        let language_changed =
            crate::i18n::set_language(config["desktop"]["language"].as_str().unwrap_or("system"));
        crate::keybindings::apply(app, &config["desktop"]["keybindings"])?;
        crate::tray::update_instances(app, config)?;
        if language_changed {
            crate::keybindings::localize(app)?;
            crate::tray::render_instances(app).map_err(|error| error.to_string())?;
        }
    }
    #[cfg(target_os = "macos")]
    if config["desktop"].is_object() {
        let quit = match config["desktop"]["quitBehavior"].as_str() {
            Some("immediate") => 0,
            Some("double-press") => 1,
            _ => 2,
        };
        if state.quit_behavior.swap(quit, Ordering::SeqCst) != quit {
            crate::shortcuts::cancel(app);
        }
        let visibility = match config["desktop"]["appVisibility"].as_str() {
            Some("dock") => 1,
            Some("tray") => 2,
            _ => 0,
        };
        if state.app_visibility.load(Ordering::SeqCst) != visibility {
            if let Some(tray) = app.tray_by_id("main") {
                tray.set_visible(visibility != 1)
                    .map_err(|e| e.to_string())?;
            }
            app.set_dock_visibility(dock_visible(
                visibility,
                app.get_webview_window("main").is_some(),
            ))
            .map_err(|e| e.to_string())?;
            state.app_visibility.store(visibility, Ordering::SeqCst);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}
#[cfg(target_os = "macos")]
fn dock_visible(preference: u8, window_open: bool) -> bool {
    preference != 2 || window_open
}
#[cfg(target_os = "macos")]
pub fn window_dock_visibility(app: &tauri::AppHandle, window_open: bool) {
    let preference = app
        .state::<std::sync::Arc<AppState>>()
        .app_visibility
        .load(Ordering::SeqCst);
    if let Err(error) = app.set_dock_visibility(dock_visible(preference, window_open)) {
        eprintln!("Cannot update Dock visibility: {error}");
    }
    if !window_open && preference == 2 {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Tao ignores DockHide for one second after DockShow to avoid duplicate Dock icons.
            tokio::time::sleep(Duration::from_millis(1100)).await;
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if handle.get_webview_window("main").is_none()
                    && handle
                        .state::<Arc<AppState>>()
                        .app_visibility
                        .load(Ordering::SeqCst)
                        == 2
                {
                    let _ = handle.set_dock_visibility(false);
                }
            });
        });
    }
}
async fn shutdown_seconds(state: &AppState) -> u64 {
    let running = read_private_json(&state.home.join("run/instance.json"), 16384)
        .await
        .unwrap_or(json!({}));
    running["shutdownDrainMs"]
        .as_u64()
        .unwrap_or(0)
        .min(2147453647)
        .div_ceil(1000)
        + 30
}
async fn read_private_json(path: &std::path::Path, limit: u64) -> Result<Value, String> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| "Instance file is unavailable")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err("Invalid instance file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Instance files must be accessible only to their owner".into());
        }
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "Cannot read instance file")?;
    let mut raw = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut raw)
        .await
        .map_err(|_| "Cannot read instance file")?;
    if raw.len() as u64 > limit {
        return Err("Invalid instance file".into());
    }
    serde_json::from_slice(&raw).map_err(|_| "Invalid instance file".into())
}
fn api_ready(status: &Value) -> bool {
    status["running"] == true && status["ready"] != false
}
pub async fn start(state: &AppState) -> Result<Value, String> {
    let mut owned = state.child.lock().await;
    if let Ok(mut error) = state.startup_error.lock() {
        *error = None;
    }
    let status = public_status(live_state(&state.home).await?.as_ref());
    if api_ready(&status) {
        return Ok(status);
    }
    let already_starting = status["running"] == true;
    if !already_starting {
        if let Some(child) = owned.as_mut() {
            if child
                .try_wait()
                .map_err(|_| "Cannot inspect local process")?
                .is_none()
            {
                return Err("The previous local server is still shutting down".into());
            }
        }
        let logs = state.home.join("logs");
        tokio::fs::create_dir_all(&logs)
            .await
            .map_err(|_| "Cannot prepare server logs")?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            std::fs::set_permissions(&logs, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect server logs")?;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let output = options
            .open(logs.join("server.log"))
            .map_err(|_| "Cannot open server log")?;
        let error = output.try_clone().map_err(|_| "Cannot open server log")?;
        let mut command = tokio::process::Command::new(executable(state));
        command
            .args(["serve", "--owner", "desktop", "--watch-parent", "--home"])
            .arg(&state.home)
            .current_dir(&state.runtime)
            .stdin(Stdio::piped())
            .stdout(output)
            .stderr(error);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000200);
        let child = command
            .spawn()
            .map_err(|_| "Could not start the packaged server")?;
        *owned = Some(child);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while tokio::time::Instant::now() < deadline {
        if let Some(child) = owned.as_mut().filter(|_| !already_starting) {
            if child
                .try_wait()
                .map_err(|_| "Cannot inspect server process")?
                .is_some()
            {
                return Err("Local server stopped during startup. Check Logs for details.".into());
            }
        }
        if let Ok(Ok(current)) = tokio::time::timeout_at(deadline, live_state(&state.home)).await {
            let status = public_status(current.as_ref());
            if api_ready(&status) {
                return Ok(status);
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Local server did not become available. Check Logs for details.".into())
}
#[cfg(test)]
mod readiness_tests {
    use super::*;

    #[test]
    fn startup_waits_for_explicit_readiness_and_accepts_legacy_status() {
        assert!(!api_ready(&json!({"running":true,"ready":false})));
        assert!(!api_ready(&json!({"running":false,"ready":true})));
        assert!(api_ready(&json!({"running":true,"ready":true})));
        assert!(api_ready(&json!({"running":true})));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn tray_only_apps_remain_switchable_until_their_window_closes() {
        assert!(dock_visible(2, true));
        assert!(!dock_visible(2, false));
        for preference in [0, 1] {
            assert!(dock_visible(preference, true));
            assert!(dock_visible(preference, false));
        }
    }
}
#[tauri::command]
pub async fn server_start(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    start(&state).await
}
pub async fn stop_owned(state: &AppState) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(shutdown_seconds(state).await);
    let result = call(state, json!({"action":"stopOwned"})).await;
    let mut owned = state.child.lock().await;
    if let Some(mut child) = owned.take() {
        drop(child.stdin.take());
        if tokio::time::timeout_at(deadline, child.wait())
            .await
            .is_err()
        {
            #[cfg(unix)]
            if let Some(id) = child.id() {
                unsafe {
                    libc::kill(-(id as i32), libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
    result.map(|_| ())
}
async fn live_state(home: &std::path::Path) -> Result<Option<Value>, String> {
    let path = home.join("run/instance.json");
    if !tokio::fs::try_exists(&path)
        .await
        .map_err(|_| "Cannot inspect local state")?
    {
        return Ok(None);
    }
    let mut current = read_private_json(&path, 16384).await?;
    let token = current["token"]
        .as_str()
        .ok_or("Invalid control token")?
        .to_owned();
    if token.len() != 64
        || !token
            .bytes()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    {
        return Err("Invalid control token".into());
    }
    let probe = async {
        #[cfg(unix)]
        let stream = tokio::net::UnixStream::connect(home.join("run/control.sock")).await;
        #[cfg(windows)]
        let stream = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(format!("\\\\.\\pipe\\trawl-{}", &token[..24]));
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                return Ok(None)
            }
            Err(_) => return Err("Cannot connect to local control".to_string()),
        };
        stream
            .write_all(format!("{}\n", json!({"action":"status", "token":token})).as_bytes())
            .await
            .map_err(|_| "Cannot query local control")?;
        let mut raw = Vec::new();
        stream
            .take(16385)
            .read_to_end(&mut raw)
            .await
            .map_err(|_| "Cannot read local status")?;
        if raw.len() > 16384 {
            return Err("Invalid control response".into());
        }
        let response: Value =
            serde_json::from_slice(&raw).map_err(|_| "Invalid control response")?;
        if response["running"] != true
            || ["pid", "baseURL", "owner", "startedAt"]
                .iter()
                .any(|key| response[key] != current[key])
        {
            return Err("Local control identity does not match its state".into());
        }
        if response["ready"].is_boolean() {
            current["ready"] = response["ready"].clone();
        }
        Ok(Some(current))
    };
    tokio::time::timeout(Duration::from_secs(3), probe)
        .await
        .map_err(|_| "Local control timed out".to_string())?
}
#[tauri::command]
pub async fn instance_status(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    local_status(&state).await
}
pub(crate) async fn local_status(state: &AppState) -> Result<Value, String> {
    Ok(public_status(live_state(&state.home).await?.as_ref()))
}
fn public_status(current: Option<&Value>) -> Value {
    let Some(current) = current else {
        return json!({"running":false});
    };
    let mut status = json!({"running":true,"pid":current["pid"],"baseURL":current["baseURL"],"owner":current["owner"],"startedAt":current["startedAt"]});
    if current["ready"].is_boolean() {
        status["ready"] = current["ready"].clone();
    }
    status
}
pub(crate) async fn local_server_pid(state: &AppState) -> Option<u32> {
    live_state(&state.home)
        .await
        .ok()
        .flatten()?
        .get("pid")?
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
}
#[tauri::command]
pub async fn api_request(
    state: State<'_, Arc<AppState>>,
    instance_id: String,
    path: String,
) -> Result<Value, String> {
    crate::streams::validate_read_path(&path)?;
    let (base, key) = instance_connection(&state, &instance_id).await?;
    let mut request = state
        .http
        .get(format!("{}{}", base.trim_end_matches('/'), path))
        .timeout(Duration::from_secs(15));
    if !key.is_empty() {
        request = request.bearer_auth(key)
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Could not connect to this instance")?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > LIMIT)
    {
        return Err("Dashboard response exceeds its budget".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read dashboard response")?
    {
        if body.len() + chunk.len() > LIMIT as usize {
            return Err("Dashboard response exceeds its budget".into());
        }
        body.extend_from_slice(&chunk)
    }
    Ok(
        json!({"status":status,"body":String::from_utf8(body).map_err(|_|"Invalid dashboard response encoding")?}),
    )
}

pub(crate) async fn instance_connection(
    state: &AppState,
    instance_id: &str,
) -> Result<(String, String), String> {
    let config_path = state.home.join("config.json");
    let config = if tokio::fs::try_exists(&config_path)
        .await
        .map_err(|_| "Cannot inspect configuration")?
    {
        read_private_json(&config_path, 1024 * 1024).await?
    } else {
        json!({})
    };
    let (base, key) = if instance_id == "local" {
        let status = live_state(&state.home)
            .await?
            .ok_or("Local server is not running")?;
        (
            status["baseURL"]
                .as_str()
                .ok_or("Local server is not running")?
                .to_owned(),
            status["dashboardToken"].as_str().unwrap_or("").to_owned(),
        )
    } else {
        let connection = config["desktop"]["connections"]
            .as_array()
            .and_then(|connections| {
                connections
                    .iter()
                    .find(|connection| connection["id"] == instance_id)
            })
            .ok_or("Unknown connection")?;
        (
            connection["baseURL"]
                .as_str()
                .ok_or("Invalid connection URL")?
                .to_owned(),
            connection["apiKey"].as_str().unwrap_or("").to_owned(),
        )
    };
    let url = reqwest::Url::parse(&base).map_err(|_| "Invalid instance URL")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid instance URL".into());
    }
    Ok((base, key))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn local_status_requires_a_live_authenticated_control_socket() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let home = std::env::temp_dir().join(format!("trawl-rust-{}", std::process::id()));
            let run = home.join("run");
            fs::create_dir_all(&run).unwrap();
            let current = json!({"pid":123,"token":"a".repeat(64),"baseURL":"http://127.0.0.1:8191","owner":"cli","startedAt":"now","dashboardToken":"private"});
            let path = run.join("instance.json");
            fs::write(&path, current.to_string()).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(live_state(&home).await.unwrap().is_none());
            let listener = tokio::net::UnixListener::bind(run.join("control.sock")).unwrap();
            let reply = current.clone();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let byte = stream.read_u8().await.unwrap();
                    if byte == b'\n' { break; }
                    request.push(byte);
                }
                let request: Value = serde_json::from_slice(&request).unwrap();
                assert_eq!(request, json!({"action":"status", "token":"a".repeat(64)}));
                let mut response = reply;
                response["running"] = json!(true);
                response["ready"] = json!(false);
                response.as_object_mut().unwrap().remove("token");
                response.as_object_mut().unwrap().remove("dashboardToken");
                stream.write_all(format!("{response}\n").as_bytes()).await.unwrap();
            });
            let live = live_state(&home).await.unwrap().unwrap();
            assert_eq!(live["pid"], 123);
            let public = public_status(Some(&live));
            assert_eq!(public["ready"], false);
            assert!(!api_ready(&public));
            assert!(public.get("token").is_none());
            assert!(public.get("dashboardToken").is_none());
            server.await.unwrap();
            fs::remove_dir_all(home).unwrap();
        });
    }
    #[test]
    fn cancelling_drains_the_child_and_preserves_a_completed_commit() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            for committed in [false, true] {
                let home = std::env::temp_dir().join(format!("trawl-cancel-{}-{committed}", std::process::id()));
                fs::create_dir_all(&home).unwrap();
                let executable = home.join("trawl-server");
                let response = if committed { json!({"ok":true,"result":{"installed":true}}) } else { json!({"ok":false,"error":"Operation cancelled"}) };
                fs::write(&executable, format!("#!/bin/sh\nIFS= read -r request\nwhile IFS= read -r rest; do :; done\nprintf '%s' '{response}'\n")).unwrap();
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
                let state = AppState {
                    runtime:home.clone(), home:home.clone(), child:tokio::sync::Mutex::new(None), quitting:std::sync::atomic::AtomicBool::new(false), close_behavior:std::sync::atomic::AtomicU8::new(0),
                    #[cfg(target_os="macos")] quit_behavior:std::sync::atomic::AtomicU8::new(2),
                    #[cfg(target_os="macos")] app_visibility:std::sync::atomic::AtomicU8::new(0),
                    http:reqwest::Client::new(),streams:crate::streams::Streams::default(),operations:crate::operations::Operations::default(),browser_operations:crate::operations::Operations::default(),startup_error:std::sync::Mutex::new(None),requested_page:std::sync::atomic::AtomicU8::new(0),
                };
                let (_sender, receiver) = tokio::sync::watch::channel(true);
                let result = call_progress(&state, json!({"action":"installBrowser"}), None, Some(receiver)).await;
                assert_eq!(result.is_ok(), committed, "{result:?}");
                fs::remove_dir_all(&home).unwrap();
            }
        });
    }
}

fn external_connection_url(value: &str) -> Result<reqwest::Url, String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("Invalid connection URL".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid connection URL")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Connection URL must be HTTP(S) without credentials, query or fragment".into());
    }
    Ok(url)
}
#[tauri::command]
pub async fn open_connection_url(url: String) -> Result<(), String> {
    let url = external_connection_url(&url)?;
    #[cfg(target_os = "windows")]
    {
        #[link(name = "Shell32")]
        extern "system" {
            fn ShellExecuteW(
                window: *mut std::ffi::c_void,
                operation: *const u16,
                file: *const u16,
                parameters: *const u16,
                directory: *const u16,
                show: i32,
            ) -> isize;
        }
        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let value: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                value.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result <= 32 {
            return Err("Could not open the connection in your browser".into());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let program = if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "xdg-open"
        };
        if !tokio::process::Command::new(program)
            .arg(url.as_str())
            .status()
            .await
            .map_err(|_| "Could not open your browser")?
            .success()
        {
            return Err("Could not open the connection in your browser".into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod external_url_tests {
    #[test]
    fn connection_links_are_web_urls_without_credentials_or_shell_execution() {
        for value in [
            "file:///tmp/owned",
            "https://user:secret@example.com",
            "https://example.com?token=owned",
            "https://example.com/#owned",
            "https://example.com\n",
        ] {
            assert!(super::external_connection_url(value).is_err());
        }
        assert_eq!(
            super::external_connection_url("http://127.0.0.1:8191")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8191/"
        );
    }
}
