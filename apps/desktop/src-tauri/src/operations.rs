use crate::{runtime::instance_connection, AppState};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    ipc::{Channel, Response},
    State,
};
use tokio::sync::watch;

const INPUT_LIMIT: usize = 1024 * 1024;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct Operations(Mutex<HashMap<String, watch::Sender<bool>>>);
impl Operations {
    pub(crate) fn register(
        &self,
        id: String,
        limit: usize,
    ) -> Result<(Registration<'_>, watch::Receiver<bool>), String> {
        if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err("Invalid operation identifier".into());
        }
        let (cancel, receiver) = watch::channel(false);
        let mut operations = self
            .0
            .lock()
            .map_err(|_| "Operation registry unavailable")?;
        if operations.len() >= limit || operations.contains_key(&id) {
            return Err(format!("At most {limit} operations can run at once"));
        }
        operations.insert(id.clone(), cancel);
        Ok((Registration(self, id), receiver))
    }
    pub(crate) fn cancel(&self, id: &str) {
        if let Ok(operations) = self.0.lock() {
            if let Some(cancel) = operations.get(id) {
                let _ = cancel.send(true);
            }
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(operations) = self.0.lock() {
            for cancel in operations.values() {
                let _ = cancel.send(true);
            }
        }
    }
}
pub(crate) struct Registration<'a>(&'a Operations, String);
impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.0 .0.lock() {
            operations.remove(&self.1);
        }
    }
}

fn validate(path: &str, body: &str) -> Result<u64, String> {
    if !["/scrape", "/read", "/extract"].contains(&path) {
        return Err("Unsupported workbench operation".into());
    }
    if body.len() > INPUT_LIMIT {
        return Err("Request exceeds the 1 MiB input limit".into());
    }
    let value: Value = serde_json::from_str(body).map_err(|_| "Invalid request JSON")?;
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .ok_or("A target URL is required")?;
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid target URL")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Use an HTTP(S) target URL without embedded credentials".into());
    }
    let timeout = match value.get("maxTimeout") {
        None => 60_000,
        Some(value) => value
            .as_u64()
            .filter(|ms| (1..=180_000).contains(ms))
            .ok_or("Timeout must be from 1 to 180000 ms")?,
    };
    Ok(timeout + 10_000)
}

fn debug_session(path: &str) -> bool {
    let Some(id) = path.strip_prefix("/sessions/desktop-debug-") else {
        return false;
    };
    id.len() == 36
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn validate_debug_session(body: &str) -> Result<u64, String> {
    if body.len() > 1024 {
        return Err("Debug session options exceed their limit".into());
    }
    let value: Value = serde_json::from_str(body).map_err(|_| "Invalid debug session JSON")?;
    let fields = value
        .as_object()
        .ok_or("Debug session options must be an object")?;
    if fields.len() != 3
        || value["headful"] != true
        || value["keepPage"] != true
        || !value["id"]
            .as_str()
            .is_some_and(|id| debug_session(&format!("/sessions/{id}")))
    {
        return Err("Only a named, retained headed debug session is supported".into());
    }
    Ok(40_000)
}
fn validate_session(body: &str) -> Result<u64, String> {
    if body.len() > 1024 {
        return Err("Session options exceed their limit".into());
    }
    let value: Value = serde_json::from_str(body).map_err(|_| "Invalid session JSON")?;
    let fields = value
        .as_object()
        .ok_or("Session options must be an object")?;
    if fields
        .keys()
        .all(|key| ["id", "keepPage"].contains(&key.as_str()))
        && value
            .get("id")
            .is_none_or(|id| id.as_str().is_some_and(valid_session_id))
        && value.get("keepPage").is_none_or(Value::is_boolean)
    {
        return Ok(40_000);
    }
    validate_debug_session(body)
}
fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

async fn cancellable<T>(
    cancel: &mut watch::Receiver<bool>,
    operation: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if *cancel.borrow() {
        return Err("Stopped waiting for the request".into());
    }
    let mut cancellation = std::pin::pin!(cancel.changed());
    let mut operation = std::pin::pin!(operation);
    std::future::poll_fn(|cx| {
        use std::task::Poll;
        if cancellation.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err("Stopped waiting for the request".into()));
        }
        operation.as_mut().poll(cx)
    })
    .await
}

#[tauri::command]
pub async fn api_operation(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    instance_id: String,
    path: String,
    method: Option<String>,
    body: String,
    operation_id: String,
    on_event: Channel<Value>,
) -> Result<Response, String> {
    let notify = method.as_deref().unwrap_or("POST") == "POST"
        && ["/scrape", "/read", "/extract"].contains(&path.as_str());
    crate::begin_background_task(&app, notify).await?;
    let status = std::sync::atomic::AtomicU64::new(0);
    let result = execute(
        &state,
        instance_id,
        path,
        method.unwrap_or_else(|| "POST".into()),
        body,
        operation_id,
        |value| {
            if value["type"] == "open" {
                status.store(
                    value["status"].as_u64().unwrap_or(0),
                    std::sync::atomic::Ordering::Relaxed,
                );
            }
            let _ = on_event.send(value);
            Ok(())
        },
    )
    .await;
    let success =
        result.is_ok() && (200..400).contains(&status.load(std::sync::atomic::Ordering::Relaxed));
    let cancelled = result
        .as_ref()
        .err()
        .is_some_and(|e| e == "Stopped waiting for the request");
    crate::finish_background_task(&app, success, notify && !cancelled);
    result.map(Response::new)
}

async fn execute(
    state: &AppState,
    instance_id: String,
    path: String,
    method: String,
    body: String,
    operation_id: String,
    emit: impl Fn(Value) -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    let timeout = if method == "GET" && path == "/browser/pages" && body.is_empty() {
        5_000
    } else if method == "GET"
        && (crate::streams::capture_path(&path, true) || crate::streams::preview_path(&path))
        && body.is_empty()
    {
        15000
    } else if method == "POST" && path == "/sessions" {
        validate_session(&body)?
    } else if method == "DELETE"
        && path
            .strip_prefix("/sessions/")
            .is_some_and(valid_session_id)
        && body.is_empty()
    {
        15_000
    } else if method == "POST" {
        validate(&path, &body)?
    } else {
        return Err("Unsupported desktop operation".into());
    };
    if operation_id.len() != 36
        || !operation_id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
    {
        return Err("Invalid operation identifier".into());
    }
    let (cancel, mut cancelled) = watch::channel(false);
    {
        let mut operations = state
            .operations
            .0
            .lock()
            .map_err(|_| "Request registry unavailable")?;
        if operations.len() >= 2 || operations.contains_key(&operation_id) {
            return Err("At most two workbench requests can run at once".into());
        }
        operations.insert(operation_id.clone(), cancel);
    }
    let _registration = Registration(&state.operations, operation_id);
    let tracked = method == "POST" && path != "/sessions";
    emit(json!({"type":"registered", "requestId":if tracked {Some(&_registration.1)}else{None}}))?;
    let transfer = async {
        let (base, key) = instance_connection(state, &instance_id).await?;
        let url = format!("{}{}", base.trim_end_matches('/'), path);
        let mut request = if method == "POST" {
            state
                .http
                .post(url)
                .header("Content-Type", "application/json")
                .body(body)
        } else if method == "DELETE" {
            state.http.delete(url)
        } else {
            state.http.get(url)
        };
        if tracked {
            request = request.header("X-Trawl-Request-ID", &_registration.1);
        }
        if !key.is_empty() {
            request = request.bearer_auth(key);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "Could not connect to this instance")?;
        let id = response
            .headers()
            .get("x-trawl-request-id")
            .and_then(|value| value.to_str().ok())
            .filter(|id| {
                id.len() <= 80
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            });
        let content_type =
            if method != "GET" || path == "/browser/pages" || path.ends_with("/captures/request") {
                "application/json"
            } else if path.ends_with("/screenshot") || crate::streams::preview_path(&path) {
                "image/jpeg"
            } else {
                "text/plain; charset=utf-8"
            };
        emit(
            json!({"type":"open", "status":response.status().as_u16(), "requestId":id,"contentType":content_type}),
        )?;
        let output_limit = if path == "/browser/pages" {
            256 * 1024
        } else if crate::streams::preview_path(&path) {
            1024 * 1024
        } else {
            OUTPUT_LIMIT
        };
        if response
            .content_length()
            .is_some_and(|size| size > output_limit as u64)
        {
            return Err("Response exceeds this desktop operation's byte limit".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read instance response")?
        {
            if bytes.len() + chunk.len() > output_limit {
                return Err("Response exceeds this desktop operation's byte limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    };
    cancellable(&mut cancelled, async {
        tokio::time::timeout(Duration::from_millis(timeout), transfer)
            .await
            .map_err(|_| "Request wait timed out")?
    })
    .await
}

#[tauri::command]
pub fn api_operation_cancel(
    state: State<'_, Arc<AppState>>,
    operation_id: String,
) -> Result<(), String> {
    if let Some(cancel) = state
        .operations
        .0
        .lock()
        .map_err(|_| "Request registry unavailable")?
        .get(&operation_id)
    {
        let _ = cancel.send(true);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn background_download_registry_bounds_and_cancels_independently() {
        let operations = Operations::default();
        let mut registered = Vec::new();
        for n in 0..3 {
            registered.push(
                operations
                    .register(format!("00000000-0000-0000-0000-{n:012}"), 3)
                    .unwrap(),
            );
        }
        assert!(operations
            .register("00000000-0000-0000-0000-000000000003".into(), 3)
            .is_err());
        operations.cancel("00000000-0000-0000-0000-000000000000");
        assert!(*registered[0].1.borrow());
        assert!(!*registered[1].1.borrow());
        registered.clear();
        assert!(operations.0.lock().unwrap().is_empty());
    }
    #[test]
    fn saved_connection_posts_json_with_private_auth_and_releases_cancelled_operations() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let home = std::env::temp_dir().join(format!("trawl-operation-{}", std::process::id()));
            std::fs::create_dir_all(&home).unwrap();
            #[cfg(unix)]
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let path = home.join("config.json");
            std::fs::write(&path, json!({"desktop":{"connections":[{"id":"fixture","baseURL":format!("http://{address}/prefix"),"apiKey":"owned-token"}]}}).to_string()).unwrap();
            #[cfg(unix)]
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
            let state = AppState {
                runtime: home.clone(), home: home.clone(), child: tokio::sync::Mutex::new(None),
                quitting: std::sync::atomic::AtomicBool::new(false), close_behavior: std::sync::atomic::AtomicU8::new(0),
                requested_page: std::sync::atomic::AtomicU8::new(0),
                #[cfg(target_os = "macos")]
                quit_behavior: std::sync::atomic::AtomicU8::new(2),
                #[cfg(target_os = "macos")]
                app_visibility: std::sync::atomic::AtomicU8::new(0),
                http: crate::http_client_builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(),
                streams: crate::streams::Streams::default(), operations: Operations::default(), browser_operations: Operations::default(), startup_error: Mutex::new(None),
            };
            let body = r#"{"url":"http://owned.fixture","method":"POST","headers":{"Content-Type":"application/json"},"body":"{\"hello\":true}"}"#;
            let served = tokio::spawn(async move {
              for step in 0..7 {
                let (mut connection, _) = listener.accept().await.unwrap();
                let mut input = Vec::new();
                while !input.ends_with(b"\r\n\r\n") { input.push(connection.read_u8().await.unwrap()); assert!(input.len() < 8192); }
                let input = String::from_utf8(input).unwrap().to_ascii_lowercase();
                assert!(input.contains("authorization: bearer owned-token"));
                if step == 0 {
                assert!(input.contains("post /prefix/scrape http/1.1"));
                assert!(input.contains("content-type: application/json"));
                let mut payload = vec![0; body.len()];
                connection.read_exact(&mut payload).await.unwrap();
                assert_eq!(payload, body.as_bytes());
                connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Trawl-Request-ID: fixture-id\r\nContent-Length: 11\r\n\r\n{\"ok\":true}").await.unwrap();
                } else if step == 1 {
                  assert!(input.contains("get /prefix/requests/captured/captures/screenshot http/1.1"));
                  assert!(!input.contains("x-trawl-request-id:"));
                  connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\xff\xd8\xff\xd9").await.unwrap();
                } else {
                  assert!(!input.contains("x-trawl-request-id:"));
                  if step == 2 {
                    assert!(input.contains("get /prefix/browser/pages http/1.1"));
                  } else if step == 4 {
                    assert!(input.contains("post /prefix/sessions http/1.1"));
                    let body=r#"{"id":"desktop-debug-10000000-0000-4000-8000-000000000000","headful":true,"keepPage":true}"#;
                    let mut payload=vec![0;body.len()];connection.read_exact(&mut payload).await.unwrap();assert_eq!(payload,body.as_bytes());
                  } else if step == 5 {
                    assert!(input.contains("delete /prefix/sessions/desktop-debug-10000000-0000-4000-8000-000000000000 http/1.1"));
                  } else {
                    assert!(input.contains("get /prefix/browser/pages/page-id/preview http/1.1"));
                  }
                  if step == 6 {
                    connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n").await.unwrap();
                  } else if step == 3 {
                    connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\xff\xd8\xff\xd9").await.unwrap();
                  } else {
                    connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}").await.unwrap();
                  }
                }
              }
            });
            let opened = std::cell::Cell::new(false);
            let id = "10000000-0000-4000-8000-000000000000";
            let result = execute(&state, "fixture".into(), "/scrape".into(), "POST".into(), body.into(), id.into(), |value| {
                if value["type"] == "open" { opened.set(true); assert_eq!(value["status"], 200); assert_eq!(value["requestId"], "fixture-id"); }
                Ok(())
            }).await.unwrap();
            assert!(opened.get());
            assert_eq!(result, b"{\"ok\":true}");
            assert!(state.operations.0.lock().unwrap().is_empty());
            let image=execute(&state,"fixture".into(),"/requests/captured/captures/screenshot".into(),"GET".into(),String::new(),id.into(),|value|{
              if value["type"] == "registered" { assert!(value["requestId"].is_null()); }
              if value["type"] == "open" { assert_eq!(value["contentType"],"image/jpeg"); }
              Ok(())
            }).await.unwrap();
            assert_eq!(image,vec![255,216,255,217]);
            assert!(state.operations.0.lock().unwrap().is_empty());
            for (method,path,body) in [
                ("GET","/browser/pages",""),
                ("GET","/browser/pages/page-id/preview",""),
                ("POST","/sessions",r#"{"id":"desktop-debug-10000000-0000-4000-8000-000000000000","headful":true,"keepPage":true}"#),
                ("DELETE","/sessions/desktop-debug-10000000-0000-4000-8000-000000000000","")
            ] {
                let result=execute(&state,"fixture".into(),path.into(),method.into(),body.into(),id.into(),|value|{if value["type"]=="registered"{assert!(value["requestId"].is_null())}Ok(())}).await.unwrap();
                assert_eq!(result.len(),if path.ends_with("/preview"){4}else{11});
            }
            let oversized=execute(&state,"fixture".into(),"/browser/pages/page-id/preview".into(),"GET".into(),String::new(),id.into(),|_|Ok(())).await.unwrap_err();
            assert!(oversized.contains("byte limit"));
            served.await.unwrap();
            let cancelled = execute(&state, "fixture".into(), "/scrape".into(), "POST".into(), body.into(), id.into(), |value| {
                if value["type"] == "registered" { state.operations.cancel_all(); }
                Ok(())
            }).await.unwrap_err();
            assert!(cancelled.contains("Stopped waiting"));
            assert!(state.operations.0.lock().unwrap().is_empty());
            std::fs::remove_dir_all(home).unwrap();
        });
    }
    #[test]
    fn operations_are_narrow_and_bounded() {
        assert_eq!(
            validate(
                "/scrape",
                r#"{"url":"http://fixture.test","maxTimeout":1000}"#
            )
            .unwrap(),
            11000
        );
        for path in [
            "/settings",
            "/sessions",
            "/v1",
            "/scrape?token=x",
            "/../scrape",
        ] {
            assert!(validate(path, r#"{"url":"http://fixture.test"}"#).is_err());
        }
        for body in [
            r#"{"url":"file:///etc/passwd"}"#,
            r#"{"url":"https://secret@fixture.test"}"#,
            r#"{"url":"https://fixture.test","maxTimeout":180001}"#,
            "[]",
        ] {
            assert!(validate("/scrape", body).is_err());
        }
        assert!(validate("/scrape", &" ".repeat(INPUT_LIMIT + 1)).is_err());
        assert!(validate_debug_session(r#"{"id":"desktop-debug-10000000-0000-4000-8000-000000000000","headful":true,"keepPage":true}"#).is_ok());
        for body in [
            r#"{"id":"other","headful":true,"keepPage":true}"#,
            r#"{"id":"desktop-debug-10000000-0000-4000-8000-000000000000","headful":false,"keepPage":true}"#,
            r#"{"id":"desktop-debug-10000000-0000-4000-8000-000000000000","headful":true,"keepPage":true,"proxy":"http://owned.fixture"}"#,
        ] {
            assert!(validate_debug_session(body).is_err());
        }
        assert!(!debug_session("/sessions/existing-user-session"));
        assert!(validate_session(r#"{"keepPage":true}"#).is_ok());
        assert!(validate_session(r#"{"id":"existing-user-session","keepPage":false}"#).is_ok());
        assert!(validate_session(r#"{"id":"../private","keepPage":true}"#).is_err());
        assert!(validate_session(r#"{"keepPage":"yes"}"#).is_err());
        assert!(!valid_session_id("session/cookies"));
        assert!(!debug_session(
            "/sessions/desktop-debug-10000000-0000-4000-8000-000000000000?x=1"
        ));
    }
}
