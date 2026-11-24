mod dns;
mod dns_wire;
use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    future::Future,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch, Semaphore};
use uuid::Uuid;
pub type Browser =
    Arc<dyn Fn(Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;
pub type Observer = Arc<dyn Fn(Value) + Send + Sync>;
const LIMIT: usize = 4 * 1024 * 1024;
const RETAINED: usize = 200;
const VERSION: &str = env!("CARGO_PKG_VERSION");
fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}
fn id() -> String {
    Uuid::new_v4().simple().to_string()
}
fn disk_json(path: &Path, value: &Value) -> Result<(), String> {
    let raw = serde_json::to_vec(value).map_err(|_| "Invalid JSON")?;
    if raw.len() > 1024 * 1024 {
        return Err("Saved data exceeds its limit".into());
    }
    let temp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options
        .open(&temp)
        .map_err(|_| "Could not save private data")?;
    file.write_all(&raw)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not save private data")?;
    std::fs::rename(temp, path).map_err(|_| "Could not publish private data".into())
}
fn read_json(path: &Path) -> Option<Value> {
    let info = std::fs::symlink_metadata(path).ok()?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
struct Server {
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}
pub struct Runtime {
    home: PathBuf,
    config: Mutex<Value>,
    server: tokio::sync::Mutex<Option<Server>>,
    running: AtomicBool,
    address: Mutex<Option<SocketAddr>>,
    started: Mutex<Instant>,
    history: Mutex<VecDeque<Value>>,
    logs: Mutex<VecDeque<Value>>,
    sequence: AtomicU64,
    epoch: String,
    requests: AtomicU64,
    successes: AtomicU64,
    total_ms: AtomicU64,
    maximum_ms: AtomicU64,
    active: AtomicUsize,
    slots: Semaphore,
    browser_slot: Semaphore,
    cancelled: watch::Sender<u64>,
    browser: Option<Browser>,
    observer: Observer,
}
impl Runtime {
    pub fn new(
        home: PathBuf,
        browser: Option<Browser>,
        observer: Observer,
    ) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(&home).map_err(|_| "Could not prepare app storage")?;
        let mut config: Value =
            serde_json::from_str(include_str!("../assets/config.json")).unwrap();
        if home.join("config.json").exists() {
            let saved = read_json(&home.join("config.json"))
                .ok_or("Configuration is invalid; the original file was kept")?;
            if saved["version"] != 1 || !saved["env"].is_object() || !saved["desktop"].is_object() {
                return Err("Unsupported saved configuration; the original file was kept".into());
            }
            config["env"]
                .as_object_mut()
                .unwrap()
                .extend(saved["env"].as_object().unwrap().clone());
            config["desktop"]
                .as_object_mut()
                .unwrap()
                .extend(saved["desktop"].as_object().unwrap().clone());
        }
        if !config["desktop"]["language"].as_str().is_some_and(|language| ["en", "cs", "sk", "pl", "de", "fr", "system"].contains(&language)) {
            config["desktop"]["language"] = json!("en");
        }
        if config["env"]["API_KEY"].as_str().is_none_or(str::is_empty) {
            config["env"]["API_KEY"] = json!(format!("{}{}", id(), id()));
        }
        disk_json(&home.join("config.json"), &config)?;
        let history = read_json(&home.join("history.json"))
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .take(RETAINED)
            .collect();
        let (cancelled, _) = watch::channel(0);
        Ok(Arc::new(Self {
            home,
            config: Mutex::new(config),
            server: tokio::sync::Mutex::new(None),
            running: AtomicBool::new(false),
            address: Mutex::new(None),
            started: Mutex::new(Instant::now()),
            history: Mutex::new(history),
            logs: Mutex::new(VecDeque::new()),
            sequence: AtomicU64::new(1),
            epoch: Uuid::new_v4().hyphenated().to_string(),
            requests: AtomicU64::new(0),
            successes: AtomicU64::new(0),
            total_ms: AtomicU64::new(0),
            maximum_ms: AtomicU64::new(0),
            active: AtomicUsize::new(0),
            slots: Semaphore::new(4),
            browser_slot: Semaphore::new(1),
            cancelled,
            browser,
            observer,
        }))
    }
    pub fn config(&self) -> Value {
        self.config.lock().unwrap().clone()
    }
    pub fn public_config(&self) -> Value {
        let mut v = self.config();
        v["env"]["API_KEY"] = json!("[redacted]");
        if let Some(rows) = v["desktop"]["connections"].as_array_mut() {
            for row in rows {
                if row.get("apiKey").is_some() {
                    row["apiKey"] = json!("[redacted]");
                }
            }
        }
        v
    }
    pub fn save(&self, mut value: Value) -> Result<Value, String> {
        let mut current = self.config.lock().unwrap();
        if value["version"] != 1 || !value["env"].is_object() || !value["desktop"].is_object() {
            return Err("Invalid configuration".into());
        }
        if value["env"].as_object().unwrap().len() > 200
            || value["env"].as_object().unwrap().iter().any(|(k, v)| {
                k.len() > 128
                    || v.as_str()
                        .is_none_or(|s| s.len() > 8192 || s.contains('\0'))
            })
        {
            return Err("Invalid environment values".into());
        }
        if value["env"]["API_KEY"] == "[redacted]" {
            value["env"]["API_KEY"] = current["env"]["API_KEY"].clone();
        }
        if value["env"]["API_KEY"]
            .as_str()
            .is_none_or(|s| s.len() < 16 || s.trim() != s || s.chars().any(char::is_control))
        {
            return Err("Use an API key of at least 16 characters".into());
        }
        dns::Resolver::new(value["env"]["DNS_RESOLVER"].as_str().unwrap_or("system"), value["env"]["DNS_SERVERS"].as_str().unwrap_or(""))?;
        let rows = value["desktop"]["connections"]
            .as_array_mut()
            .ok_or("Invalid connections")?;
        if rows.len() > 24 {
            return Err("At most 24 connections are supported".into());
        }
        let mut ids = std::collections::HashSet::new();
        for row in rows {
            let identifier = row["id"].as_str().ok_or("Invalid connection ID")?;
            if identifier == "local"
                || identifier.len() > 80
                || !identifier
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                || !ids.insert(identifier.to_owned())
            {
                return Err("Invalid connection ID".into());
            }
            if row["name"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.len() > 160)
            {
                return Err("Invalid connection name".into());
            }
            target_url(row["baseURL"].as_str().ok_or("Invalid instance URL")?)?;
            if row["apiKey"] == "[redacted]" {
                row["apiKey"] = current["desktop"]["connections"]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|r| r["id"] == identifier))
                    .map(|r| r["apiKey"].clone())
                    .unwrap_or(Value::Null);
            }
        }
        if let Some(port) = value["env"]["PORT"].as_str() {
            if port.parse::<u16>().ok().is_none_or(|n| n == 0) {
                return Err("Port must be between 1 and 65535".into());
            }
        }
        let incoming = value["desktop"].as_object().unwrap().clone();
        let mut desktop = current["desktop"].clone();
        desktop.as_object_mut().unwrap().extend(incoming);
        value["desktop"] = desktop;
        for key in [
            "autostart",
            "startServerOnLaunch",
            "smoothScroll",
            "liveActivities",
            "interactionSounds",
            "hapticFeedback",
        ] {
            if !value["desktop"][key].is_boolean() {
                return Err(format!("Invalid {key} preference"));
            }
        }
        if !value["desktop"]["keybindings"].is_object() {
            return Err("Invalid keybindings".into());
        }
        let language = match value["desktop"].get("language") {
            Some(Value::String(language)) => language.clone(),
            None => "system".to_owned(),
            _ => return Err("Invalid language preference".into()),
        };
        if !["en", "cs", "sk", "pl", "de", "fr", "system"].contains(&language.as_str()) {
            return Err("Invalid language preference".into());
        }
        value["desktop"]["language"] = json!(language);
        disk_json(&self.home.join("config.json"), &value)?;
        *current = value;
        drop(current);
        Ok(self.public_config())
    }
    pub fn catalog(&self) -> Value {
        serde_json::from_str(include_str!("../assets/catalog.json")).unwrap()
    }
    pub fn status(&self) -> Value {
        let url = self.address.lock().unwrap().map(|a| {
            let ip = if a.ip().is_unspecified() {
                if a.is_ipv6() {
                    "::1".parse().unwrap()
                } else {
                    "127.0.0.1".parse().unwrap()
                }
            } else {
                a.ip()
            };
            format!("http://{}", SocketAddr::new(ip, a.port()))
        });
        json!({"running":self.running.load(Ordering::SeqCst),"ready":self.running.load(Ordering::SeqCst),"owner":"desktop","baseURL":url})
    }
    pub fn summary(&self) -> Value {
        let config = self.config.lock().unwrap();
        let live_activities = config["desktop"]["liveActivities"].as_bool().unwrap_or(true);
        let language = config["desktop"]["language"].as_str().unwrap_or("system").to_owned();
        drop(config);
        json!({"running":self.running.load(Ordering::SeqCst),"active":self.active.load(Ordering::SeqCst),"requests":self.requests.load(Ordering::Relaxed),"successes":self.successes.load(Ordering::Relaxed),"failures":self.requests.load(Ordering::Relaxed).saturating_sub(self.successes.load(Ordering::Relaxed)),"baseURL":self.status()["baseURL"],"uptime":self.started.lock().unwrap().elapsed().as_secs(),"liveActivities":live_activities,"language":language})
    }
    fn changed(&self) {
        (self.observer)(self.summary());
    }
    pub async fn start(self: &Arc<Self>, bind: Option<SocketAddr>) -> Result<Value, String> {
        let mut server = self.server.lock().await;
        if self.running.load(Ordering::SeqCst) {
            return Ok(self.status());
        }
        let cfg = self.config();
        let address = match bind {
            Some(a) => a,
            None => SocketAddr::new(
                cfg["env"]["HOST"]
                    .as_str()
                    .unwrap_or("127.0.0.1")
                    .parse::<IpAddr>()
                    .map_err(|_| "HOST must be an IP address")?,
                cfg["env"]["PORT"]
                    .as_str()
                    .unwrap_or("8191")
                    .parse()
                    .map_err(|_| "Invalid port")?,
            ),
        };
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .map_err(|e| format!("Could not start server: {e}"))?;
        *self.address.lock().unwrap() = Some(
            listener
                .local_addr()
                .map_err(|_| "Could not inspect server address")?,
        );
        *self.started.lock().unwrap() = Instant::now();
        self.running.store(true, Ordering::SeqCst);
        let (stop, stopped) = oneshot::channel();
        let runtime = self.clone();
        let app = router(self.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await;
            runtime.running.store(false, Ordering::SeqCst);
            runtime.changed();
        });
        *server = Some(Server { stop, task });
        self.log("info", "server.ready");
        self.changed();
        Ok(self.status())
    }
    pub async fn stop(&self) -> Result<Value, String> {
        let mut server = self.server.lock().await;
        self.cancelled.send_modify(|v| *v += 1);
        if let Some(mut owned) = server.take() {
            self.running.store(false, Ordering::SeqCst);
            let _ = owned.stop.send(());
            if tokio::time::timeout(Duration::from_secs(8), &mut owned.task)
                .await
                .is_err()
            {
                owned.task.abort();
            }
        }
        self.log("info", "server.stopped");
        self.changed();
        Ok(self.status())
    }
    pub fn clear(&self, category: &str) -> Result<Value, String> {
        if category == "downloads" {
            return Ok(json!({"cleared":category}));
        }
        if self.running.load(Ordering::SeqCst) {
            return Err("Stop the local server before clearing storage".into());
        }
        match category {
            "history" => {
                self.history.lock().unwrap().clear();
                disk_json(&self.home.join("history.json"), &json!([]))?;
            }
            "logs" => self.logs.lock().unwrap().clear(),
            "captures" => {}
            _ => return Err("Unknown storage category".into()),
        }
        Ok(json!({"cleared":category}))
    }
    fn cursor(&self) -> String {
        format!("{}:{}", self.epoch, self.sequence.load(Ordering::Relaxed))
    }
    pub fn log_text(&self) -> String {
        self.logs
            .lock()
            .unwrap()
            .iter()
            .map(|v| {
                format!(
                    "{} {} api {}",
                    v["data"]["at"].as_str().unwrap_or(""),
                    v["data"]["level"].as_str().unwrap_or("info"),
                    v["data"]["message"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    pub fn log(&self, level: &str, message: &str) {
        let mut logs = self.logs.lock().unwrap();
        logs.push_back(json!({"id":format!("{}:{}",self.epoch,self.sequence.fetch_add(1,Ordering::Relaxed)),"data":{"at":now(),"level":level,"scope":"api","message":message}}));
        while logs.len() > 500 {
            logs.pop_front();
        }
    }
    fn pool(&self) -> Value {
        let busy = usize::from(self.browser_slot.available_permits() == 0);
        json!({"total":usize::from(self.browser.is_some()),"busy":busy,"available":usize::from(self.browser.is_some()).saturating_sub(busy),"restarts":0,"avgRestarts":0,"stalled":0,"live":usize::from(self.browser.is_some()),"queueDepth":0})
    }
    fn metrics(&self, minutes: u64) -> Value {
        let history = self.history.lock().unwrap();
        let boundary = time::OffsetDateTime::now_utc() - time::Duration::minutes(minutes as i64);
        let rows = history
            .iter()
            .filter(|row| {
                row["at"]
                    .as_str()
                    .and_then(|s| {
                        time::OffsetDateTime::parse(
                            s,
                            &time::format_description::well_known::Rfc3339,
                        )
                        .ok()
                    })
                    .is_some_and(|at| at >= boundary)
            })
            .collect::<Vec<_>>();
        let requests = rows.len() as u64;
        let successes = rows.iter().filter(|row| row["success"] == true).count() as u64;
        let total = rows
            .iter()
            .map(|row| row["durationMs"].as_u64().unwrap_or(0))
            .sum::<u64>();
        let maximum = rows
            .iter()
            .map(|row| row["durationMs"].as_u64().unwrap_or(0))
            .max()
            .unwrap_or(0);
        let mut buckets = std::collections::BTreeMap::<String, (u64, u64, u64)>::new();
        for row in &rows {
            let minute = format!(
                "{}:00Z",
                row["at"].as_str().unwrap_or("").get(..16).unwrap_or("")
            );
            let bucket = buckets.entry(minute).or_default();
            bucket.0 += 1;
            bucket.1 += u64::from(row["success"] != true);
            bucket.2 += row["durationMs"].as_u64().unwrap_or(0);
        }
        let timeline=buckets.into_iter().map(|(minute,(requests,failures,total))|json!({"minute":minute,"requests":requests,"failures":failures,"averageMs":total/requests})).collect::<Vec<_>>();
        json!({"startedAt":null,"rangeMinutes":minutes,"retainedEvents":history.len(),"bucketMs":60000,"requests":requests,"successes":successes,"failures":requests-successes,"averageMs":if requests>0 {total/requests}else{0},"maximumMs":maximum,"bySource":{"native":requests},"byTier":{},"timeline":timeline,"domains":[],"recentEvents":rows.into_iter().rev().take(5).cloned().collect::<Vec<_>>()})
    }
    async fn scrape(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let url = target_url(value["url"].as_str().ok_or("A target URL is required")?)?;
        let method = value["method"].as_str().unwrap_or("GET");
        if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].contains(&method) {
            return Err("Unsupported HTTP method".into());
        }
        for key in [
            "proxy",
            "session",
            "sessionId",
            "browserSession",
            "ignoreCertificateErrors",
            "screenshot",
            "consoleLogs",
            "networkLogs",
            "auth",
            "targetAuth",
            "bodyBase64",
            "bodyEncoding",
        ] {
            if value
                .get(key)
                .is_some_and(|v| !v.is_null() && v != false && v != "")
            {
                return Err(format!("{key} is not available in the Android runtime"));
            }
        }
        if value
            .get("body")
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err("Android HTTP bodies must be text".into());
        }
        if value
            .get("cookies")
            .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
        {
            return Err("Input cookies are not yet supported by the Android runtime".into());
        }
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| "The Android request limit is reached")?;
        self.active.fetch_add(1, Ordering::SeqCst);
        self.changed();
        struct Active(Arc<Runtime>);
        impl Drop for Active {
            fn drop(&mut self) {
                self.0.active.fetch_sub(1, Ordering::SeqCst);
                self.0.changed();
            }
        }
        let _active = Active(self.clone());
        let started = Instant::now();
        let started_at = now();
        let mut stages = Vec::new();
        let request_id = id();
        let cfg = self.config();
        let timeout = value
            .get("maxTimeout")
            .map(|v| {
                v.as_u64()
                    .filter(|n| (1..=180000).contains(n))
                    .ok_or("Timeout must be between 1 and 180000 ms")
            })
            .transpose()?
            .unwrap_or_else(|| {
                cfg["env"]["SCRAPE_MAX_TIMEOUT_MS"]
                    .as_str()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(60000)
            })
            .clamp(1, 180000);
        let min_tier = value["minTier"].as_u64().unwrap_or_else(|| {
            cfg["env"]["SCRAPE_MIN_TIER"]
                .as_str()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1)
        });
        let max_tier = value["maxTier"].as_u64().unwrap_or_else(|| {
            cfg["env"]["SCRAPE_MAX_TIER"]
                .as_str()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3)
        });
        if min_tier > 3 || max_tier < 1 || min_tier > max_tier {
            return Err("The Android runtime supports HTTP tier 1 and WebView tier 3".into());
        }
        let resolver = dns::Resolver::new(cfg["env"]["DNS_RESOLVER"].as_str().unwrap_or("system"), cfg["env"]["DNS_SERVERS"].as_str().unwrap_or(""))?;
        let mut cancelled = self.cancelled.subscribe();
        let work = async {
            let force = value["skipHttp"] == true || value["render"] == true || min_tier > 1;
            let mut timings = vec![];
            if !force {
                let before = Instant::now();
                let mut measured = MeasuredStage::new("tier", Some(1), &mut stages);
                let mut client = crate::http_client_builder().no_proxy();
                if let Some(resolver) = &resolver { client = client.dns_resolver(resolver.clone()); }
                let client = client
                    .redirect(reqwest::redirect::Policy::limited(10))
                    .timeout(Duration::from_millis(timeout))
                    .build()
                    .map_err(|_| "Could not prepare HTTP client")?;
                let mut request = client
                    .request(method.parse().map_err(|_| "Invalid method")?, url.clone())
                    .header("User-Agent", "TRAWL-Android/0.1");
                if let Some(headers) = value["headers"].as_object() {
                    if headers.len() > 80 {
                        return Err("Too many headers".into());
                    }
                    for (k, v) in headers {
                        if ["host", "content-length", "connection", "transfer-encoding"]
                            .contains(&k.to_ascii_lowercase().as_str())
                        {
                            return Err("Unsupported target header".into());
                        }
                        request = request.header(k, v.as_str().ok_or("Invalid header value")?);
                    }
                }
                if let Some(body) = value["body"].as_str() {
                    if body.len() > 512 * 1024 {
                        return Err("Target body exceeds its limit".into());
                    }
                    request = request.body(body.to_owned());
                }
                let mut response = request
                    .send()
                    .await
                    .map_err(|e| format!("Target request failed: {e}"))?;
                if response.content_length().is_some_and(|v| v > LIMIT as u64) {
                    return Err("Target response exceeds 4 MiB".into());
                }
                let status = response.status().as_u16();
                let final_url = response.url().to_string();
                let headers: serde_json::Map<String, Value> = response
                    .headers()
                    .iter()
                    .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), json!(v))))
                    .collect();
                let mut raw = Vec::new();
                while let Some(bytes) = response
                    .chunk()
                    .await
                    .map_err(|_| "Could not read target response")?
                {
                    if raw.len() + bytes.len() > LIMIT {
                        return Err("Target response exceeds 4 MiB".into());
                    }
                    raw.extend_from_slice(&bytes);
                }
                let html = String::from_utf8(raw).map_err(|_| {
                    "Android responses must be UTF-8 text; binary responses are unavailable"
                })?;
                let blocked = [403, 429, 503].contains(&status)
                    || ["cf-chl-", "Just a moment...", "enable JavaScript"]
                        .iter()
                        .any(|s| html.contains(s));
                let duration = before.elapsed().as_millis() as u64;
                let mut attempt = json!({"tier":1,"status":if blocked{"needs-js"}else{"success"},"durationMs":duration});
                if blocked { attempt["reason"] = json!("android-render-required"); }
                timings.push(attempt.clone());
                measured.status = if blocked { "needs-js" } else { "success" };
                measured.reason = if blocked { Some("android-render-required") } else { None };
                drop(measured);
                if !blocked || self.browser.is_none() || max_tier < 3 {
                    return Ok(
                        json!({"requestId":request_id,"url":final_url,"html":html,"cookies":[],"userAgent":"TRAWL-Android/0.1","statusCode":status,"tier":1,"sessionCached":false,"timings":timings,"totalMs":started.elapsed().as_millis() as u64,"responseHeaders":headers,"contentType":headers.get("content-type").cloned().unwrap_or(json!("text/html"))}),
                    );
                }
            }
            if max_tier < 3 {
                return Err("Browser rendering requires maxTier of at least 3".into());
            }
            if method != "GET"
                || value.get("body").is_some()
                || value["headers"].as_object().is_some_and(|h| !h.is_empty())
            {
                return Err("Android browser rendering currently accepts GET requests without custom headers or bodies".into());
            }
            let browser = self
                .browser
                .as_ref()
                .ok_or("Browser rendering is unavailable")?;
            let mut acquisition = MeasuredStage::new("browser-acquire", None, &mut stages);
            let _browser = self
                .browser_slot
                .acquire()
                .await
                .map_err(|_| "Browser renderer unavailable")?;
            acquisition.status = "success";
            drop(acquisition);
            let before = Instant::now();
            let mut measured = MeasuredStage::new("tier", Some(3), &mut stages);
            let mut input = value.clone();
            input["requestId"] = json!(request_id);
            input["url"] = json!(url.as_str());
            input["maxTimeout"] = json!(timeout);
            let proxy = if let Some(resolver) = &resolver { Some(dns::Proxy::start(resolver.clone()).await?) } else { None };
            if let Some(proxy) = &proxy {
                input["proxyPort"] = json!(proxy.port);
                input["proxyToken"] = json!(proxy.token);
            }
            let mut result = browser(input).await?;
            drop(proxy);
            if result["html"].as_str().is_none_or(|s| s.len() > LIMIT) {
                return Err("Browser response exceeds 4 MiB".into());
            }
            let duration = before.elapsed().as_millis() as u64;
            timings.push(json!({"tier":3,"status":"success","durationMs":duration}));
            measured.status = "success";
            drop(measured);
            result["requestId"] = json!(request_id);
            result["tier"] = json!(3);
            result["sessionCached"] = json!(false);
            result["timings"] = json!(timings);
            result["totalMs"] = json!(started.elapsed().as_millis() as u64);
            Ok(result)
        };
        let result: Result<Value, String> = tokio::select! {value=tokio::time::timeout(Duration::from_millis(timeout),work)=>value.map_err(|_|"Request timed out".to_string()).and_then(|v|v),_=cancelled.changed()=>Err("Request cancelled because the server stopped".into())};
        let elapsed = started.elapsed().as_millis() as u64;
        self.requests.fetch_add(1, Ordering::Relaxed);
        if result.as_ref().is_ok_and(|v| {
            v["statusCode"]
                .as_u64()
                .is_some_and(|s| (200..400).contains(&s))
        }) {
            self.successes.fetch_add(1, Ordering::Relaxed);
        }
        self.total_ms.fetch_add(elapsed, Ordering::Relaxed);
        self.maximum_ms.fetch_max(elapsed, Ordering::Relaxed);
        let diagnostics = mobile_diagnostics(&started_at, &stages, &result, &method);
        let row = json!({"diagnostics":diagnostics,"id":request_id,"at":now(),"domain":url.host_str().unwrap_or(""),"source":"native","method":method,"durationMs":elapsed,"success":result.as_ref().is_ok_and(|v|v["statusCode"].as_u64().is_some_and(|s|(200..400).contains(&s))),"statusCode":result.as_ref().ok().and_then(|v|v["statusCode"].as_u64()),"tier":result.as_ref().ok().and_then(|v|v["tier"].as_u64()),"category":null,"severity":null,"tierStatus":null});
        {
            let mut rows = self.history.lock().unwrap();
            rows.push_back(row);
            while rows.len() > RETAINED {
                rows.pop_front();
            }
            let _ = disk_json(&self.home.join("history.json"), &json!(*rows));
        }
        self.changed();
        result
    }
}
struct MeasuredStage<'a> {
    stages: &'a mut Vec<Value>,
    kind: &'static str,
    tier: Option<u64>,
    at: String,
    started: Instant,
    status: &'static str,
    reason: Option<&'static str>,
}
impl<'a> MeasuredStage<'a> {
    fn new(kind: &'static str, tier: Option<u64>, stages: &'a mut Vec<Value>) -> Self {
        Self { stages, kind, tier, at: now(), started: Instant::now(), status: "error", reason: None }
    }
}
impl Drop for MeasuredStage<'_> {
    fn drop(&mut self) {
        let mut stage = json!({"kind":self.kind,"startedAt":self.at,"durationMs":self.started.elapsed().as_millis() as u64,"status":self.status});
        if let Some(tier) = self.tier { stage["tier"] = json!(tier); }
        if let Some(reason) = self.reason { stage["reason"] = json!(reason); }
        if self.stages.len() < 32 { self.stages.push(stage); }
    }
}

fn mobile_diagnostics(started_at: &str, stages: &[Value], result: &Result<Value, String>, method: &str) -> Value {
    let output = result.as_ref().ok();
    let status = output.and_then(|v| v["statusCode"].as_u64());
    let timings = output.and_then(|v| v["timings"].as_array()).cloned().unwrap_or_else(|| stages.iter().filter(|stage| stage["kind"] == "tier").map(|stage| {
        let mut timing = json!({"tier":stage["tier"],"status":stage["status"],"durationMs":stage["durationMs"]});
        if stage["reason"].is_string() { timing["reason"] = stage["reason"].clone(); }
        timing
    }).collect());
    let mut value = json!({
        "startedAt":started_at,"operation":"scrape","stages":stages,"timings":timings,"challenges":[],
        "verification":[
            {"check":"http-status","status":match status {Some(200..=399)=>"passed",Some(_)=>"failed",None=>"skipped"}},
            {"check":"engine-outcome","status":if output.is_none(){"failed"}else if timings.last().is_some_and(|v|v["status"]=="success"){"passed"}else{"failed"}},
            {"check":"response-content","status":if output.is_none() || method=="HEAD" || matches!(status,Some(204|304)){"skipped"}else if output.is_some_and(|v|v["html"].as_str().is_some_and(|s|!s.is_empty())){"passed"}else{"failed"}}
        ]
    });
    if let Some(output) = output {
        value["responseBytes"] = json!(output["html"].as_str().map(str::len).unwrap_or(0));
    }
    if result.is_err() || status.is_some_and(|s|s>=400) {
        let error = result.as_ref().err().map(|s|s.to_lowercase()).unwrap_or_default();
        value["cause"] = json!(if error.contains("timed out") || error.contains("timeout") {"timeout"}
            else if matches!(status,Some(403|429)){"suspected-security-block"}
            else if status.is_some_and(|s|s>=400){"http"}
            else if error.contains("browser"){"browser"}
            else if error.contains("http") || error.contains("target response") || error.contains("target request failed"){"network"}
            else {"internal"});
    }
    value
}

fn target_url(raw: &str) -> Result<reqwest::Url, String> {
    if raw.len() > 8192 {
        return Err("Target URL exceeds its limit".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid URL")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || ["tauri.localhost", "ipc.localhost", "asset.localhost"]
            .contains(&url.host_str().unwrap_or(""))
    {
        return Err("Use an HTTP(S) URL without embedded credentials".into());
    }
    Ok(url)
}
async fn authenticated(
    State(runtime): State<Arc<Runtime>>,
    request: Request,
    next: Next,
) -> Response {
    if ["/", "/health"].contains(&request.uri().path()) {
        return next.run(request).await;
    }
    let expected = runtime.config()["env"]["API_KEY"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if header != format!("Bearer {expected}") {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Authentication required"})),
        )
            .into_response();
    }
    next.run(request).await
}
fn error(message: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error":message}))).into_response()
}
fn router(runtime: Arc<Runtime>) -> Router {
    Router::new().route("/",get(|State(r):State<Arc<Runtime>>|async move {Json(json!({"msg":"TRAWL Android runtime","version":VERSION,"uptime":r.started.lock().unwrap().elapsed().as_secs(),"platform":"android"}))}))
    .route("/health",get(|State(r):State<Arc<Runtime>>|async move {Json(json!({"status":"ok","uptime":r.started.lock().unwrap().elapsed().as_secs(),"pool":r.pool()}))}))
    .route("/stats",get(|State(r):State<Arc<Runtime>>|async move {Json(json!({"browsers":usize::from(r.browser.is_some()),"headful":null}))}))
    .route("/capabilities",get(||async {Json(json!({"version":1,"authentication":"bearer","clientRequestIds":false,"requestQuery":false,"requestOptions":{"binaryBodies":false,"targetAuth":false},"settings":true,"requests":true,"requestEvents":false,"logs":true,"logEvents":false,"captures":false,"browserInspection":false,"platform":"android"}))}))
    .route("/settings",get(|State(r):State<Arc<Runtime>>|async move {let cfg=r.config();Json(json!({"readOnly":true,"settings":r.catalog().as_array().unwrap().iter().map(|v|json!({"name":v["name"],"group":v["group"],"description":v["description"],"kind":v["kind"],"source":"runtime","secret":v["secret"].as_bool().unwrap_or(false),"value":if v["secret"]==true {Value::Null}else{cfg["env"].get(v["name"].as_str().unwrap()).cloned().unwrap_or_else(||v["default"].clone())},"configured":v["secret"]==true})).collect::<Vec<_>>()}))}))
    .route("/dashboard/metrics",get(|State(r):State<Arc<Runtime>>,axum::extract::Query(query):axum::extract::Query<std::collections::HashMap<String,String>>|async move {let minutes=query.get("minutes").and_then(|s|s.parse::<u64>().ok()).filter(|n|[15,60,1440,10080,43200].contains(n)).unwrap_or(60);Json(r.metrics(minutes))}))
    .route("/requests",get(history_page))
    .route("/requests/{id}",get(|State(r):State<Arc<Runtime>>,axum::extract::Path(id):axum::extract::Path<String>|async move {r.history.lock().unwrap().iter().find(|v|v["id"]==id).cloned().map(Json).ok_or(StatusCode::NOT_FOUND)}))
    .route("/logs",get(|State(r):State<Arc<Runtime>>|async move {Json(json!({"cursor":r.cursor(),"coverage":"structured-application-logs-since-start","entries":*r.logs.lock().unwrap()}))}))
    .route("/sessions",get(||async {Json(json!({"sessions":[]}))}))
    .route("/scrape",post(|State(r):State<Arc<Runtime>>,Json(v):Json<Value>|async move {match r.scrape(v).await {Ok(v)=>Json(v).into_response(),Err(e)=>error(e)}}))
    .route("/read",post(read)).route("/extract",post(extract)).route("/v1",post(flare))
    .layer(DefaultBodyLimit::max(1024*1024)).layer(middleware::from_fn_with_state(runtime.clone(),authenticated)).with_state(runtime)
}
async fn history_page(
    State(runtime): State<Arc<Runtime>>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let limit = query
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let rows = runtime.history.lock().unwrap();
    let reverse = rows.iter().rev().collect::<Vec<_>>();
    let start = match query.get("before") {
        None => 0,
        Some(id) => match reverse
            .iter()
            .position(|row| row["id"].as_str() == Some(id))
        {
            Some(i) => i + 1,
            None => return error("History cursor expired; refresh the first page".into()),
        },
    };
    let entries = reverse
        .iter()
        .skip(start)
        .take(limit)
        .map(|row| (*row).clone())
        .collect::<Vec<_>>();
    let next = if start + entries.len() < rows.len() {
        entries.last().map(|row| row["id"].clone())
    } else {
        None
    };
    Json(json!({"entries":entries,"total":rows.len(),"nextCursor":next,"cursor":runtime.cursor(),"active":[],"activeTruncated":false})).into_response()
}
async fn read(State(r): State<Arc<Runtime>>, Json(v): Json<Value>) -> Response {
    match r.scrape(v.clone()).await {
        Err(e) => error(e),
        Ok(mut result) => {
            let html = scraper::Html::parse_document(result["html"].as_str().unwrap_or(""));
            let title = html
                .select(&scraper::Selector::parse("title").unwrap())
                .next()
                .map(|n| n.text().collect::<String>())
                .unwrap_or_default();
            let text = html
                .select(&scraper::Selector::parse("body").unwrap())
                .next()
                .map(|n| n.text().collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let max = v["maxCharacters"].as_u64().unwrap_or(200000).min(500000) as usize;
            let truncated = text.chars().count() > max;
            let text: String = text.chars().take(max).collect();
            result.as_object_mut().unwrap().remove("html");
            result["title"] = json!(title);
            result["characters"] = json!(text.chars().count());
            result["text"] = json!(text);
            result["format"] = json!(if v["format"] == "text" {
                "text"
            } else {
                "markdown"
            });
            result["truncated"] = json!(truncated);
            Json(result).into_response()
        }
    }
}
async fn extract(State(r): State<Arc<Runtime>>, Json(v): Json<Value>) -> Response {
    let Some(fields) = v["fields"].as_object() else {
        return error("Extraction fields are required".into());
    };
    if fields.is_empty() || fields.len() > 32 {
        return error("Use 1 to 32 extraction fields".into());
    }
    let selector = match scraper::Selector::parse(v["itemSelector"].as_str().unwrap_or("html")) {
        Ok(v) => v,
        Err(_) => return error("Invalid item selector".into()),
    };
    let mut parsed = vec![];
    for (key, field) in fields {
        if key.len() > 128
            || field["selector"].as_str().is_none_or(|s| s.len() > 512)
            || field["attribute"].as_str().is_some_and(|s| s.len() > 128)
        {
            return error("Extraction field exceeds its limit".into());
        }
        match scraper::Selector::parse(field["selector"].as_str().unwrap_or(":")) {
            Ok(s) => parsed.push((
                key.clone(),
                s,
                field["attribute"].as_str().map(str::to_owned),
            )),
            Err(_) => return error("Invalid field selector".into()),
        }
    }
    match r.scrape(v.clone()).await {
        Err(e) => error(e),
        Ok(mut result) => {
            let html = scraper::Html::parse_document(result["html"].as_str().unwrap_or(""));
            let max = v["maxItems"].as_u64().unwrap_or(100).min(500) as usize;
            let matches = html.select(&selector).take(501).collect::<Vec<_>>();
            let mut items = vec![];
            let mut remaining = 100_000usize;
            let mut truncated = matches.len() > max;
            for item in matches.iter().take(max) {
                let mut row = serde_json::Map::new();
                for (key, s, attr) in &parsed {
                    let allowance = remaining.min(2000);
                    let value = item.select(s).next().and_then(|n| {
                        let text = match attr {
                            Some(a) => n
                                .value()
                                .attr(a)
                                .map(|text| text.chars().take(allowance + 1).collect::<String>()),
                            None => Some(
                                n.text()
                                    .flat_map(str::chars)
                                    .take(allowance + 1)
                                    .collect::<String>(),
                            ),
                        }?;
                        let count = text.chars().count();
                        truncated |= count > allowance;
                        remaining = remaining.saturating_sub(count.min(allowance));
                        Some(text.chars().take(allowance).collect::<String>())
                    });
                    row.insert(key.clone(), json!(value));
                }
                items.push(row);
            }
            result.as_object_mut().unwrap().remove("html");
            result["items"] = json!(items);
            result["matched"] = json!(matches.len());
            result["truncated"] = json!(truncated);
            Json(result).into_response()
        }
    }
}
async fn flare(State(r): State<Arc<Runtime>>, Json(mut v): Json<Value>) -> Response {
    let cmd = v["cmd"].as_str().unwrap_or("");
    if !["request.get", "request.post"].contains(&cmd) {
        return error(
            "Android supports request.get and request.post; persistent sessions are unavailable"
                .into(),
        );
    }
    v["method"] = json!(if cmd == "request.post" { "POST" } else { "GET" });
    if let Some(body) = v.get("postData").cloned() {
        v["body"] = body;
    }
    let started = SystemTimeMs::now();
    match r.scrape(v).await{Err(e)=>Json(json!({"status":"error","message":e,"startTimestamp":started,"endTimestamp":SystemTimeMs::now(),"version":VERSION})).into_response(),Ok(v)=>Json(json!({"status":"ok","message":"","startTimestamp":started,"endTimestamp":SystemTimeMs::now(),"version":VERSION,"solution":{"url":v["url"],"status":v["statusCode"],"headers":v["responseHeaders"],"response":v["html"],"cookies":v["cookies"],"userAgent":v["userAgent"]}})).into_response()}
}
struct SystemTimeMs;
impl SystemTimeMs {
    fn now() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_activity_preference_defaults_migrates_and_persists() {
        let home = std::env::temp_dir().join(format!("trawl-mobile-activity-{}", id()));
        let core = Runtime::new(home.clone(), None, Arc::new(|_| {})).unwrap();
        assert_eq!(core.summary()["liveActivities"], true);
        let mut config = core.config();
        config["desktop"]["liveActivities"] = json!(false);
        core.save(config).unwrap();
        assert_eq!(core.summary()["liveActivities"], false);
        drop(core);
        let core = Runtime::new(home.clone(), None, Arc::new(|_| {})).unwrap();
        assert_eq!(core.summary()["liveActivities"], false);
        let mut invalid = core.config();
        invalid["desktop"]["liveActivities"] = json!("false");
        assert!(core.save(invalid).is_err());
        let mut legacy = core.config();
        legacy["desktop"].as_object_mut().unwrap().remove("liveActivities");
        drop(core);
        disk_json(&home.join("config.json"), &legacy).unwrap();
        let core = Runtime::new(home.clone(), None, Arc::new(|_| {})).unwrap();
        assert_eq!(core.summary()["liveActivities"], true);
        drop(core);
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn language_preference_migrates_and_preserves_the_server_configuration() {
        let home = std::env::temp_dir().join(format!("trawl-mobile-language-{}", id()));
        let core = Runtime::new(home.clone(), None, Arc::new(|_| {})).unwrap();
        assert_eq!(core.summary()["language"], "system");
        assert!(core.config()["desktop"].get("localName").is_none());
        for language in ["cs", "sk", "pl", "de", "fr", "system", "en"] {
            let mut config = core.config();
            let api_key = config["env"]["API_KEY"].clone();
            config["desktop"]["language"] = json!(language);
            core.save(config).unwrap();
            assert_eq!(core.summary()["language"], language);
            assert_eq!(core.config()["env"]["API_KEY"], api_key);
        }
        let mut config = core.config();
        config["desktop"]["language"] = json!("unknown");
        assert!(core.save(config.clone()).is_err());
        drop(core);
        disk_json(&home.join("config.json"), &config).unwrap();
        let core = Runtime::new(home.clone(), None, Arc::new(|_| {})).unwrap();
        assert_eq!(core.summary()["language"], "en");
        let mut config = core.config();
        config["desktop"].as_object_mut().unwrap().remove("language");
        drop(core);
        disk_json(&home.join("config.json"), &config).unwrap();
        let core = Runtime::new(home.clone(), None, Arc::new(|_| {})).unwrap();
        assert_eq!(core.summary()["language"], "system");
        drop(core);
        std::fs::remove_dir_all(home).unwrap();
    }
    async fn fixture() -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/page",
            get(|| async {
                axum::response::Html(
                    "<html><title>Owned page</title><body><h1>Hello Android</h1></body></html>",
                )
            }),
        );
        let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}/page"), handle)
    }
    #[tokio::test]
    async fn public_api_auth_scrape_read_extract_v1_history_and_restart() {
        let home = std::env::temp_dir().join(format!("trawl-mobile-{}", id()));
        let core = Runtime::new(home.clone(), None, Arc::new(|_| {})).unwrap();
        let catalog = core.catalog();
        let dns_setting = catalog
            .as_array()
            .unwrap()
            .iter()
            .find(|setting| setting["name"] == "DNS_RESOLVER")
            .expect("Android settings must expose instance DNS");
        assert_eq!(
            dns_setting["choices"],
            json!(["system", "cloudflare", "google", "quad9", "quad9-unfiltered", "adguard", "adguard-unfiltered", "custom"])
        );
        assert_eq!(core.config()["env"]["DNS_RESOLVER"], "system");
        let status = core
            .start(Some("127.0.0.1:0".parse().unwrap()))
            .await
            .unwrap();
        let base = status["baseURL"].as_str().unwrap();
        let token = core.config()["env"]["API_KEY"].as_str().unwrap().to_owned();
        let client = reqwest::Client::new();
        let (target, task) = fixture().await;
        assert_eq!(
            client
                .post(format!("{base}/scrape"))
                .json(&json!({"url":target}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for path in ["scrape", "read", "extract", "v1"] {
            let mut input = json!({"url":target});
            if path == "extract" {
                input["fields"] = json!({"heading":{"selector":"h1"}});
            }
            if path == "v1" {
                input["cmd"] = json!("request.get");
            }
            let response = client
                .post(format!("{base}/{path}"))
                .bearer_auth(&token)
                .json(&input)
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success());
            let value: Value = response.json().await.unwrap();
            match path {
                "scrape" => {
                    assert_eq!(value["tier"], 1);
                    assert!(value["html"].as_str().unwrap().contains("Hello Android"));
                }
                "read" => assert_eq!(value["title"], "Owned page"),
                "extract" => assert_eq!(value["items"][0]["heading"], "Hello Android"),
                _ => assert_eq!(value["status"], "ok"),
            }
        }
        let history: Value = client
            .get(format!("{base}/requests"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(history["total"], 4);
        let mut public = core.public_config();
        public["desktop"]["localName"] = json!("Owned phone");
        core.save(public).unwrap();
        assert_eq!(core.config()["env"]["API_KEY"], token);
        assert!(core
            .scrape(json!({"url":target,"skipHttp":true,"maxTier":1}))
            .await
            .unwrap_err()
            .contains("maxTier"));
        core.stop().await.unwrap();
        assert_eq!(core.status()["running"], false);
        task.abort();
        drop(core);
        let reopened = Runtime::new(home.clone(), None, Arc::new(|_| {})).unwrap();
        assert_eq!(reopened.config()["desktop"]["localName"], "Owned phone");
        assert_eq!(reopened.history.lock().unwrap().len(), 5);
        std::fs::remove_dir_all(home).unwrap();
    }
    #[tokio::test]
    async fn explicit_ipv6_listener_remains_reachable_through_its_reported_url() {
        let home = std::env::temp_dir().join(format!("trawl-mobile-ipv6-{}", id()));
        let core = Runtime::new(home.clone(), None, Arc::new(|_| {})).unwrap();
        let status = core.start(Some("[::1]:0".parse().unwrap())).await.unwrap();
        let base = status["baseURL"].as_str().unwrap();
        assert!(base.starts_with("http://[::1]:"));
        let response = crate::http_client_builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("{base}/health"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        core.stop().await.unwrap();
        std::fs::remove_dir_all(home).unwrap();
    }
    #[tokio::test]
    async fn history_pages_and_extraction_keep_public_limits() {
        let home = std::env::temp_dir().join(format!("trawl-mobile-bounds-{}", id()));
        let browser: Browser = Arc::new(|v| {
            Box::pin(async move {
                Ok(
                    json!({"url":v["url"],"html":format!("<html><head><title>Bounded</title></head><body><section>{}</section></body></html>","x".repeat(20000)),"statusCode":200,"cookies":[],"userAgent":"Owned","contentType":"text/html"}),
                )
            })
        });
        let core = Runtime::new(home.clone(), Some(browser), Arc::new(|_| {})).unwrap();
        let status = core
            .start(Some("127.0.0.1:0".parse().unwrap()))
            .await
            .unwrap();
        let base = status["baseURL"].as_str().unwrap();
        let token = core.config()["env"]["API_KEY"].as_str().unwrap().to_owned();
        let client = reqwest::Client::new();
        let value:Value=client.post(format!("{base}/extract")).bearer_auth(&token).json(&json!({"url":"https://example.invalid/","skipHttp":true,"fields":{"title":{"selector":"title"},"long":{"selector":"section"}}})).send().await.unwrap().json().await.unwrap();
        assert_eq!(value["items"][0]["title"], "Bounded");
        assert_eq!(value["items"][0]["long"].as_str().unwrap().len(), 2000);
        assert_eq!(value["truncated"], true);
        let response=client.post(format!("{base}/scrape")).bearer_auth(&token).json(&json!({"url":"https://example.invalid/","targetAuth":{"type":"bearer","token":"private"}})).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        for _ in 0..22 {
            core.scrape(json!({"url":"https://example.invalid/","skipHttp":true}))
                .await
                .unwrap();
        }
        let first: Value = client
            .get(format!("{base}/requests?limit=20"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(first["entries"].as_array().unwrap().len(), 20);
        let last: Value = client
            .get(format!(
                "{base}/requests?limit=20&before={}",
                first["nextCursor"].as_str().unwrap()
            ))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(last["entries"].as_array().unwrap().len(), 3);
        assert_eq!(last["nextCursor"], Value::Null);
        core.stop().await.unwrap();
        std::fs::remove_dir_all(home).unwrap();
    }
    #[tokio::test]
    async fn shutdown_cancels_a_render_without_an_activity_or_frontend_callback() {
        let home = std::env::temp_dir().join(format!("trawl-mobile-cancel-{}", id()));
        let browser: Browser = Arc::new(|_| Box::pin(std::future::pending()));
        let core = Runtime::new(home.clone(), Some(browser), Arc::new(|_| {})).unwrap();
        core.start(Some("127.0.0.1:0".parse().unwrap()))
            .await
            .unwrap();
        let c = core.clone();
        let request = tokio::spawn(async move {
            c.scrape(json!({"url":"https://example.invalid/","skipHttp":true,"maxTimeout":10000}))
                .await
        });
        while core.active.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        core.stop().await.unwrap();
        assert!(request.await.unwrap().unwrap_err().contains("cancelled"));
        assert_eq!(core.active.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(home).unwrap();
    }
}

#[cfg(test)]
mod request_diagnostics_tests {
    use super::*;
    #[test]
    fn diagnostics_use_recorded_evidence_and_never_copy_raw_errors() {
        let stages = vec![json!({"kind":"tier","tier":1,"startedAt":"2026-01-01T00:00:00Z","durationMs":12,"status":"success"})];
        let response = Ok(json!({"statusCode":403,"html":"blocked","timings":[{"tier":1,"status":"needs-js","durationMs":12}]}));
        let value = mobile_diagnostics("2026-01-01T00:00:00Z", &stages, &response, "GET");
        assert_eq!(value["cause"], "suspected-security-block");
        assert_eq!(value["verification"][0]["status"], "failed");
        assert_eq!(value["stages"][0]["durationMs"], 12);
        let failed = mobile_diagnostics("2026-01-01T00:00:00Z", &[], &Err("Request timed out https://private.test/secret".into()), "GET");
        assert_eq!(failed["cause"], "timeout");
        assert!(!failed.to_string().contains("private.test"));
        assert_eq!(failed["verification"][0]["status"], "skipped");
    }
    #[test]
    fn interrupted_attempts_keep_measured_failure_spans() {
        let mut stages = Vec::new();
        {
            let mut first = MeasuredStage::new("tier", Some(1), &mut stages);
            first.status = "needs-js";
            first.reason = Some("android-render-required");
        }
        { let _failed = MeasuredStage::new("tier", Some(3), &mut stages); }
        let value = mobile_diagnostics("2026-01-01T00:00:00Z", &stages, &Err("Target request failed: DNS error".into()), "GET");
        assert_eq!(value["timings"].as_array().unwrap().len(), 2);
        assert_eq!(value["timings"][0]["reason"], "android-render-required");
        assert_eq!(value["timings"][1]["status"], "error");
        assert_eq!(value["cause"], "network");
    }

}

// Keep the bundled Mozilla trust store when upgrading reqwest's default verifier.
pub(crate) fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().tls_certs_only(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().map(
        |cert| reqwest::Certificate::from_der(cert.as_ref()).expect("bundled root certificate"),
    ))
}
