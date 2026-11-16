use crate::AppState;
use serde_json::{json, Value};
use std::{
    process::Stdio,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::State;
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
pub async fn call(state: &AppState, mut request: Value) -> Result<Value, String> {
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
    let deadline = if ["installBrowser", "repairBrowser"]
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
        .stderr(Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "The packaged runtime is missing or could not start")?;
    let mut stdin = child.stdin.take().ok_or("Runtime input unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(deadline), async {
        stdin
            .write_all(&input)
            .await
            .map_err(|_| "Could not send management request")?;
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .ok_or("Runtime output unavailable")?
            .take(LIMIT + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| "Could not read runtime response")?;
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
    })
    .await;
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
pub async fn management(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    request: Value,
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
        "browserStatus",
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
    let mut result = match call(&state, request).await {
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
    update_behavior(&state, config);
    if action == "bootstrap" {
        if let Ok(mut error) = state.startup_error.lock() {
            if let Some(error) = error.take() {
                result["startupError"] = json!(error);
            }
        }
    }
    Ok(result)
}
pub fn update_behavior(state: &AppState, config: &Value) {
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
pub async fn start(state: &AppState) -> Result<Value, String> {
    let mut owned = state.child.lock().await;
    let status = call(state, json!({"action":"status"})).await?;
    if status["running"] == true {
        return Ok(status);
    }
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
    for _ in 0..100 {
        if let Some(child) = owned.as_mut() {
            if child
                .try_wait()
                .map_err(|_| "Cannot inspect server process")?
                .is_some()
            {
                return Err("Local server stopped during startup. Check Logs for details.".into());
            }
        }
        if let Ok(status) = call(state, json!({"action":"status"})).await {
            if status["running"] == true {
                return Ok(status);
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Local server did not become available. Check Logs for details.".into())
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
    let current = read_private_json(&path, 16384).await?;
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
        Ok(Some(current))
    };
    tokio::time::timeout(Duration::from_secs(3), probe)
        .await
        .map_err(|_| "Local control timed out".to_string())?
}
#[tauri::command]
pub async fn instance_status(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let Some(current) = live_state(&state.home).await? else {
        return Ok(json!({"running":false}));
    };
    Ok(
        json!({"running":true,"pid":current["pid"],"baseURL":current["baseURL"],"owner":current["owner"],"startedAt":current["startedAt"]}),
    )
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
                response.as_object_mut().unwrap().remove("token");
                response.as_object_mut().unwrap().remove("dashboardToken");
                stream.write_all(format!("{response}\n").as_bytes()).await.unwrap();
            });
            assert_eq!(live_state(&home).await.unwrap().unwrap()["pid"], 123);
            server.await.unwrap();
            fs::remove_dir_all(home).unwrap();
        });
    }
}
