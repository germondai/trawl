use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};

const FEED: &str = "https://github.com/germondai/trawl/releases/latest/download/app-updates.json";

#[cfg(any(target_os = "android", test))]
fn feed_available(status: reqwest::StatusCode) -> Result<bool, &'static str> {
    match status.as_u16() {
        404 => Ok(false),
        403 => Err("native.feedAccessDenied"),
        429 => Err("native.feedRateLimited"),
        200..=299 => Ok(true),
        _ => Err("native.feedUnavailable"),
    }
}

#[cfg(not(target_os = "android"))]
static PENDING: Mutex<Option<tauri_plugin_updater::Update>> = Mutex::new(None);
#[cfg(target_os = "android")]
static PENDING: Mutex<Option<String>> = Mutex::new(None);
#[cfg(not(target_os = "android"))]
static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(not(target_os = "android"))]
async fn read_package(
    mut response: reqwest::Response,
    limit: usize,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, String> {
    let total = response.content_length();
    if total.is_some_and(|size| size > limit as u64) {
        return Err("native.updateTooLarge".to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "native.updateInterrupted".to_owned())?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("native.updateTooLarge".to_owned());
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len() as u64, total);
    }
    Ok(bytes)
}

fn trusted_asset(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url
                .path()
                .starts_with("/germondai/trawl/releases/download/")
            && !url.path().contains("/../")
    })
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let current = app.package_info().version.to_string();
    match app
        .updater_builder()
        .endpoints(vec![FEED.parse().unwrap()])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
    {
        Ok(Some(update)) => {
            if !trusted_asset(update.download_url.as_str()) {
                return Err("native.updateUntrusted".to_owned());
            }
            let value = json!({"state":"available","current":current,"version":update.version,"notes":update.body});
            *PENDING.lock().unwrap() = Some(update);
            Ok(value)
        }
        Ok(None) => {
            *PENDING.lock().unwrap() = None;
            Ok(json!({"state":"current","current":current}))
        }
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
            Ok(json!({"state":"unpublished","current":current}))
        }
        Err(_) => Err("native.updateCheckFailed".to_owned()),
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle) -> Result<Value, String> {
    use std::sync::{atomic::Ordering, Arc};
    use tauri::{Emitter, Manager};
    let _installing = INSTALLING
        .try_lock()
        .map_err(|_| "native.updateInProgress".to_owned())?;
    let update = PENDING
        .lock()
        .unwrap()
        .clone()
        .ok_or("native.checkUpdateFirst".to_owned())?;
    let progress = app.clone();
    let mut reported = None::<std::time::Instant>;
    let client = crate::http_client_builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|_| "native.updatePrepareFailed".to_owned())?;
    let response = client
        .get(update.download_url.clone())
        .send()
        .await
        .map_err(|_| "native.updateDownloadFailed".to_owned())?
        .error_for_status()
        .map_err(|_| "native.updateEndpointUnavailable".to_owned())?;
    let bytes = read_package(response, 512 * 1024 * 1024, move |downloaded, total| {
        if reported.is_none_or(|at| at.elapsed() >= Duration::from_millis(100))
            || Some(downloaded) == total
        {
            reported = Some(std::time::Instant::now());
            let _ = progress.emit(
                "app-update-progress",
                json!({"downloaded":downloaded,"total":total,"state":"downloading"}),
            );
        }
    })
    .await?;
    update
        .verify(&bytes)
        .map_err(|_| "native.signatureFailed")?;
    let _ = app.emit("app-update-progress", json!({"state":"installing"}));
    let state = app.state::<Arc<crate::AppState>>();
    state.streams.cancel_all();
    state.operations.cancel_all();
    state.browser_operations.cancel_all();
    crate::runtime::stop_owned(&state).await?;
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|_| "native.updaterFailed")?
        .map_err(|_| "native.installFailed")?;
    state.quitting.store(true, Ordering::SeqCst);
    app.restart();
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.clone();
    let client = crate::http_client_builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(4))
        .read_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|_| "native.prepareCheckFailed")?;
    let mut response = client
        .get(FEED)
        .header("User-Agent", "TRAWL-updater")
        .send()
        .await
        .map_err(|_| "native.feedConnectionFailed")?;
    if !feed_available(response.status())? {
        return Ok(json!({"state":"unpublished","current":current.to_string()}));
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "native.readFeedFailed")?
    {
        if data.len() + chunk.len() > 65536 {
            return Err("native.feedTooLarge".to_owned());
        }
        data.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&data).map_err(|_| "native.invalidFeed")?;
    let version = value["version"].as_str().ok_or("native.missingVersion")?;
    let next = semver::Version::parse(version).map_err(|_| "native.invalidVersion")?;
    if next <= current || !next.pre.is_empty() {
        return Ok(json!({"state":"current","current":current.to_string()}));
    }
    let target = if cfg!(target_arch = "aarch64") {
        "android-aarch64"
    } else {
        "android-armv7"
    };
    let url = value["platforms"][target]["url"]
        .as_str()
        .ok_or("native.architectureUnavailable")?;
    if !trusted_asset(url) || !url.ends_with(".apk") {
        return Err("native.updateAsset".to_owned());
    }
    *PENDING.lock().unwrap() = Some(url.into());
    Ok(
        json!({"state":"available","current":current.to_string(),"version":version,"notes":value["notes"]}),
    )
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn install_app_update(_app: tauri::AppHandle) -> Result<Value, String> {
    let url = PENDING.lock().unwrap().clone().ok_or("native.checkAndroidUpdate")?;
    crate::mobile::bridge::call("openUrl", json!({"url":url})).await?;
    Ok(json!({"state":"idle"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_app_feeds_are_unpublished_but_access_errors_are_not() {
        use reqwest::StatusCode;
        assert_eq!(feed_available(StatusCode::OK), Ok(true));
        assert_eq!(feed_available(StatusCode::NOT_FOUND), Ok(false));
        assert_eq!(
            feed_available(StatusCode::FORBIDDEN),
            Err("native.feedAccessDenied")
        );
        assert_eq!(
            feed_available(StatusCode::TOO_MANY_REQUESTS),
            Err("native.feedRateLimited")
        );
        assert_eq!(
            feed_available(StatusCode::BAD_GATEWAY),
            Err("native.feedUnavailable")
        );
    }
    #[test]
    fn only_accepts_release_assets_from_the_owned_repository() {
        assert!(trusted_asset(
            "https://github.com/germondai/trawl/releases/download/v2.0.0/TRAWL.app.tar.gz"
        ));
        for value in [
            "http://github.com/germondai/trawl/releases/download/v2/a.apk",
            "https://github.com.attacker.test/germondai/trawl/releases/download/v2/a.apk",
            "https://github.com/other/trawl/releases/download/v2/a.apk",
            "https://user@github.com/germondai/trawl/releases/download/v2/a.apk",
        ] {
            assert!(!trusted_asset(value));
        }
    }
    #[cfg(not(target_os = "android"))]
    #[tokio::test]
    async fn rejects_oversize_update_responses_with_and_without_a_content_length() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for response in ["HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\n123456789", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n9\r\n123456789\r\n0\r\n\r\n"] {
                let (mut socket,_)=listener.accept().await.unwrap();let mut request=[0;1024];let _=socket.read(&mut request).await.unwrap();socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let client = crate::http_client_builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        for _ in 0..2 {
            let response = client
                .get(format!("http://{address}/fixture"))
                .send()
                .await
                .unwrap();
            assert!(read_package(response, 8, |_, _| {}).await.is_err());
        }
        server.await.unwrap();
    }
}
