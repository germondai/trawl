use crate::{runtime::instance_connection, AppState};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, State};
use tokio::sync::watch;

struct Control {
    cancel: watch::Sender<bool>,
    ack: watch::Sender<u64>,
    sent: AtomicU64,
}

#[derive(Default)]
pub(crate) struct Streams(Mutex<HashMap<String, Arc<Control>>>);

impl Streams {
    pub fn cancel_all(&self) {
        if let Ok(streams) = self.0.lock() {
            for stream in streams.values() {
                let _ = stream.cancel.send(true);
            }
        }
    }
}

struct Registration<'a>(&'a Streams, String);
impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut streams) = self.0 .0.lock() {
            streams.remove(&self.1);
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(crate) fn validate_read_path(path: &str) -> Result<(), String> {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if path.len() > if route == "/requests" { 4096 } else { 512 } {
        return Err("API path exceeds its budget".into());
    }
    let detail = route.strip_prefix("/requests/").is_some_and(valid_id);
    let markdown = route
        .strip_prefix("/requests/")
        .and_then(|value| value.strip_suffix("/markdown"))
        .is_some_and(valid_id);
    if ![
        "/",
        "/health",
        "/stats",
        "/dashboard/metrics",
        "/capabilities",
        "/settings",
        "/requests",
        "/logs",
        "/sessions",
        "/session-activity",
        "/browser/pages",
    ]
    .contains(&route)
        && !detail
        && !markdown
        && !capture_path(route, false)
    {
        return Err("API route is not available to the desktop".into());
    }
    // Streams have a separate transport; no query credentials or arbitrary forwarded parameters.
    if route == "/requests/events" {
        return Err("Use the streaming transport".into());
    }
    if query.is_empty() {
        return Ok(());
    }
    let mut names = std::collections::HashSet::new();
    for (name, value) in reqwest::Url::parse(&format!("http://trawl.invalid/?{query}"))
        .map_err(|_| "Invalid API query")?
        .query_pairs()
    {
        if !names.insert(name.to_string()) {
            return Err("Duplicate API query parameter".into());
        }
        let valid = match (route, name.as_ref()) {
            ("/dashboard/metrics", "minutes") => {
                ["15", "60", "1440", "10080", "43200"].contains(&value.as_ref())
            }
            ("/requests" | "/session-activity", "limit") => value
                .parse::<u16>()
                .is_ok_and(|number| (1..=100).contains(&number)),
            ("/session-activity", "requestId") => {
                !value.is_empty()
                    && value.len() <= 80
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            }
            ("/session-activity", "sessionId") => {
                !value.is_empty()
                    && value.len() <= 128
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            }
            ("/logs", "limit") => value
                .parse::<u16>()
                .is_ok_and(|number| (1..=500).contains(&number)),
            ("/requests", "before") => valid_id(&value),
            ("/session-activity", "page") => value
                .parse::<u32>()
                .is_ok_and(|page| (1..=5000).contains(&page)),
            ("/requests", "page") => value
                .parse::<u32>()
                .is_ok_and(|page| (1..=50000).contains(&page)),
            ("/requests", "search") => {
                value.len() <= 800
                    && value.chars().count() <= 200
                    && !value.chars().any(char::is_control)
            }
            ("/requests", "source") => {
                ["native", "flaresolverr", "mcp", "proxy"].contains(&value.as_ref())
            }
            ("/requests", "result") => ["success", "failed"].contains(&value.as_ref()),
            ("/requests", "sort") => {
                ["newest", "oldest", "slowest", "fastest"].contains(&value.as_ref())
            }
            ("/requests", "tier") => ["0", "1", "2", "3", "4"].contains(&value.as_ref()),
            _ => false,
        };
        if !valid {
            return Err("Invalid API query".into());
        }
    }
    Ok(())
}

fn valid_cursor(cursor: &str) -> bool {
    let Some((epoch, sequence)) = cursor.split_once(':') else {
        return false;
    };
    epoch.len() == 36
        && epoch
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        && !sequence.is_empty()
        && sequence.len() <= 16
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn preview_path(path: &str) -> bool {
    if path.len() > 256 {
        return false;
    }
    let parts: Vec<_> = path.split('/').collect();
    parts.len() == 5
        && parts[0].is_empty()
        && parts[1] == "browser"
        && parts[2] == "pages"
        && valid_id(parts[3])
        && parts[4] == "preview"
}

pub(crate) fn capture_path(path: &str, binary: bool) -> bool {
    if path.len() > 256 {
        return false;
    }
    let parts: Vec<_> = path.split('/').collect();
    let length = if binary { 5 } else { 4 };
    parts.len() == length
        && parts[0].is_empty()
        && ["requests", "session-activity"].contains(&parts[1])
        && valid_id(parts[2])
        && parts[3] == "captures"
        && (!binary || ["html", "screenshot", "request"].contains(&parts[4]))
}

async fn bounded<T>(
    cancel: &mut watch::Receiver<bool>,
    seconds: u64,
    operation: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if *cancel.borrow() {
        return Err("Stream cancelled".into());
    }
    let mut cancellation = std::pin::pin!(cancel.changed());
    let mut operation = std::pin::pin!(tokio::time::timeout(
        Duration::from_secs(seconds),
        operation
    ));
    std::future::poll_fn(|context| {
        use std::task::Poll;
        if cancellation.as_mut().poll(context).is_ready() {
            return Poll::Ready(Err("Stream cancelled".into()));
        }
        match operation.as_mut().poll(context) {
            Poll::Ready(Ok(result)) => Poll::Ready(result),
            Poll::Ready(Err(_)) => Poll::Ready(Err("Stream timed out".into())),
            Poll::Pending => Poll::Pending,
        }
    })
    .await
}

#[tauri::command]
pub async fn api_stream(
    state: State<'_, Arc<AppState>>,
    instance_id: String,
    topic: String,
    stream_id: String,
    cursor: Option<String>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    forward_stream(&state, instance_id, topic, stream_id, cursor, |value| {
        on_event
            .send(value)
            .map_err(|_| "Stream viewer closed".to_string())
    })
    .await
}

async fn forward_stream(
    state: &AppState,
    instance_id: String,
    topic: String,
    stream_id: String,
    cursor: Option<String>,
    emit: impl Fn(Value) -> Result<(), String> + Send + Sync,
) -> Result<(), String> {
    if !["requests", "logs"].contains(&topic.as_str()) || !valid_id(&stream_id) {
        return Err("Invalid stream".into());
    }
    if cursor.as_deref().is_some_and(|value| !valid_cursor(value)) {
        return Err("Invalid stream cursor".into());
    }
    let (cancel, mut cancelled) = watch::channel(false);
    let (ack, mut acknowledged) = watch::channel(0u64);
    let control = Arc::new(Control {
        cancel,
        ack,
        sent: AtomicU64::new(0),
    });
    {
        let mut streams = state
            .streams
            .0
            .lock()
            .map_err(|_| "Stream registry unavailable")?;
        if streams.contains_key(&stream_id) || streams.len() >= 4 {
            return Err("Too many desktop streams".into());
        }
        streams.insert(stream_id.clone(), control.clone());
    }
    let _registration = Registration(&state.streams, stream_id);
    emit(json!({"type":"registered"}))?;
    let (base, key) = bounded(
        &mut cancelled,
        15,
        instance_connection(&state, &instance_id),
    )
    .await?;
    let mut request = state
        .http
        .get(format!("{}/{topic}/events", base.trim_end_matches('/')));
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    if let Some(cursor) = cursor {
        request = request.header("Last-Event-ID", cursor);
    }
    let mut response = bounded(&mut cancelled, 15, async {
        request
            .send()
            .await
            .map_err(|_| "Could not connect to the event stream".to_string())
    })
    .await?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        emit(json!({"type":"open","status":status}))?;
        return Ok(());
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"))
    {
        return Err("Instance did not return an event stream".into());
    }
    emit(json!({"type":"open","status":status}))?;
    let mut frame = Vec::new();
    let mut sequence = 0u64;
    loop {
        let chunk = bounded(&mut cancelled, 35, async {
            response
                .chunk()
                .await
                .map_err(|_| "Could not read the event stream".to_string())
        })
        .await?
        .ok_or("Event stream closed")?;
        for byte in chunk {
            frame.push(byte);
            if frame.len() > 16 * 1024 {
                return Err("Stream event exceeds its budget".into());
            }
            if frame.ends_with(b"\n\n") || frame.ends_with(b"\r\n\r\n") {
                let text = std::str::from_utf8(&frame).map_err(|_| "Invalid stream encoding")?;
                sequence += 1;
                control.sent.store(sequence, Ordering::SeqCst);
                emit(json!({"type":"data","sequence":sequence,"frame":text}))?;
                // At most one frame is in flight through IPC, even if the WebView stops reading.
                bounded(&mut cancelled, 10, async {
                    while *acknowledged.borrow() < sequence {
                        acknowledged
                            .changed()
                            .await
                            .map_err(|_| "Stream viewer closed".to_string())?;
                    }
                    Ok(())
                })
                .await?;
                frame.clear();
            }
        }
    }
}

#[tauri::command]
pub fn api_stream_ack(
    state: State<'_, Arc<AppState>>,
    stream_id: String,
    sequence: u64,
) -> Result<(), String> {
    let streams = state
        .streams
        .0
        .lock()
        .map_err(|_| "Stream registry unavailable")?;
    if let Some(stream) = streams.get(&stream_id) {
        if sequence != stream.sent.load(Ordering::SeqCst) {
            return Err("Invalid stream acknowledgement".into());
        }
        let _ = stream.ack.send(sequence);
    }
    Ok(())
}

#[tauri::command]
pub fn api_stream_cancel(state: State<'_, Arc<AppState>>, stream_id: String) -> Result<(), String> {
    let streams = state
        .streams
        .0
        .lock()
        .map_err(|_| "Stream registry unavailable")?;
    if let Some(stream) = streams.get(&stream_id) {
        let _ = stream.cancel.send(true);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn native_transport_reads_large_batches_and_releases_its_registration_on_cancel() {
        use std::os::unix::fs::PermissionsExt;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let home = std::env::temp_dir().join(format!("trawl-stream-{}", std::process::id()));
            std::fs::create_dir_all(&home).unwrap();
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let path = home.join("config.json");
            std::fs::write(&path, json!({"desktop":{"connections":[{"id":"fixture","baseURL":format!("http://{address}"),"apiKey":"owned-token"}]}}).to_string()).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            let state = Arc::new(AppState {
                runtime: home.clone(), home: home.clone(), child: tokio::sync::Mutex::new(None),
                quitting: std::sync::atomic::AtomicBool::new(false), close_behavior: std::sync::atomic::AtomicU8::new(0),
                requested_page: std::sync::atomic::AtomicU8::new(0),
                #[cfg(target_os = "macos")]
                quit_behavior: std::sync::atomic::AtomicU8::new(2),
                #[cfg(target_os = "macos")]
                app_visibility: std::sync::atomic::AtomicU8::new(0),
                http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(),
                streams: Streams::default(), operations: crate::operations::Operations::default(), browser_operations: crate::operations::Operations::default(), startup_error: Mutex::new(None),
            });
            let served = tokio::spawn(async move {
                let (mut connection, _) = listener.accept().await.unwrap();
                let mut input = Vec::new();
                while !input.ends_with(b"\r\n\r\n") {
                    input.push(connection.read_u8().await.unwrap());
                    assert!(input.len() < 8192);
                }
                let input = String::from_utf8(input).unwrap().to_ascii_lowercase();
                assert!(input.contains("get /requests/events http/1.1"));
                assert!(input.contains("authorization: bearer owned-token"));
                assert!(!input.contains("?"));
                connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                let frame = format!("event: entry\ndata: {{\"message\":\"{}\"}}\n\n", "x".repeat(900));
                let batch = frame.repeat(200);
                connection.write_all(format!("{:x}\r\n{}\r\n0\r\n\r\n", batch.len(), batch).as_bytes()).await.unwrap();
            });
            let received = AtomicU64::new(0);
            let result = forward_stream(&state, "fixture".into(), "requests".into(), "stream-fixture".into(), None, |value| {
                if value["type"] == "data" {
                    let sequence = value["sequence"].as_u64().unwrap();
                    received.fetch_add(1, Ordering::SeqCst);
                    let streams = state.streams.0.lock().unwrap();
                    let control = streams.get("stream-fixture").unwrap();
                    control.ack.send(sequence).unwrap();
                    if sequence == 200 { control.cancel.send(true).unwrap(); }
                }
                Ok(())
            }).await;
            assert_eq!(received.load(Ordering::SeqCst), 200);
            assert!(result.unwrap_err().contains("cancelled"));
            assert!(state.streams.0.lock().unwrap().is_empty());
            served.await.unwrap();
            std::fs::remove_dir_all(home).unwrap();
        });
    }
    #[test]
    fn permits_only_read_resources_and_validated_queries() {
        assert!(validate_read_path(&format!("/requests?search={}", "%C4%8D".repeat(200))).is_ok());
        for path in [
            "/settings",
            "/capabilities",
            "/browser/pages",
            "/requests?limit=50&before=request-id",
            "/requests?limit=20&page=3&search=owned.test&source=proxy&result=success&sort=slowest&tier=3",
            "/requests/test-id",
            "/requests/test-id/markdown",
            "/requests/test-id/captures",
            "/session-activity?limit=50&sessionId=retained-session",
            "/session-activity?sessionId=retained-session&requestId=request-a",
            "/session-activity?limit=20&page=2",
            "/session-activity/eval-id/captures",
            "/logs?limit=100",
            "/dashboard/metrics?minutes=60",
        ] {
            assert!(validate_read_path(path).is_ok(), "{path}");
        }
        for path in [
            "/scrape",
            "/requests/test-id/markdown?token=secret",
            "/requests/bad!id/markdown",
            "/logs/events",
            "/requests/events",
            "/settings?token=secret",
            "/requests/../settings",
            "/requests?limit=101",
            "/session-activity?limit=101",
            "/session-activity?page=5001",
            "/session-activity?sessionId=../secret",
            "/requests?page=0",
            "/requests?search=%00",
            "/requests?source=unknown",
            "/requests?result=unknown",
            "/requests?sort=unknown",
            "/requests?tier=5",
            "/requests?page=1&page=2",
            "/logs?limit=1&limit=2",
            "https://elsewhere.test",
            "/requests?before=bad%2Fid",
            "/requests/test-id/captures/html",
            "/requests/test-id/captures?token=secret",
            "/browser/pages?token=secret",
            "/browser/pages/test-id/preview",
        ] {
            assert!(validate_read_path(path).is_err(), "{path}");
        }
    }
    #[test]
    fn rejects_query_credentials_and_oversized_stream_cursors() {
        assert!(valid_cursor("10000000-0000-4000-8000-000000000000:1"));
        for value in [
            "1",
            "token=secret",
            "../settings",
            "10000000-0000-4000-8000-000000000000:99999999999999999999999999",
        ] {
            assert!(!valid_cursor(value));
        }
        assert!(capture_path("/requests/test-id/captures/html", true));
        assert!(capture_path("/requests/test-id/captures/screenshot", true));
        assert!(preview_path("/browser/pages/test-id/preview"));
        assert!(!preview_path("/browser/pages/test-id/preview?token=x"));
        assert!(!preview_path(&"/".repeat(10000)));
        for path in [
            "/settings",
            "/requests/../captures/html",
            "/requests/test-id/captures/other",
            "/requests/test-id/captures/html?token=x",
        ] {
            assert!(!capture_path(path, true));
        }
    }
}
