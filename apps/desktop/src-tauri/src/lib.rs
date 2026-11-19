#[cfg(not(target_os = "android"))]
include!("desktop.rs");

#[cfg(target_os = "android")]
mod mobile;

#[cfg(target_os = "android")]
#[tauri::mobile_entry_point]
pub fn run() {
    mobile::run();
}

#[cfg(target_os = "android")]
pub use mobile::AppState;
#[cfg(target_os = "android")]
mod operations;
#[cfg(target_os = "android")]
#[path = "mobile/runtime.rs"]
mod runtime;
#[cfg(target_os = "android")]
mod streams;

#[cfg(target_os = "android")]
use tauri::Manager;

pub(crate) async fn begin_background_task(
    app: &tauri::AppHandle,
    _notify: bool,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        mobile::ensure_service(app).await?;
        app.state::<std::sync::Arc<AppState>>()
            .client_jobs
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        mobile::sync_state(app).await;
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_notification::NotificationExt;
        if _notify
            && app
                .get_webview_window("main")
                .is_some_and(|w| w.is_focused().unwrap_or(false))
        {
            let handle = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                handle.notification().request_permission()
            })
            .await;
        }
    }
    Ok(())
}
pub(crate) fn finish_background_task(app: &tauri::AppHandle, success: bool, notify: bool) {
    #[cfg(target_os = "android")]
    {
        app.state::<std::sync::Arc<AppState>>()
            .client_jobs
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
    if notify {
        notify_background(
            app,
            if success {
                "Request completed"
            } else {
                "Request failed"
            },
            "Open TRAWL to view the result.",
        );
    }
}
pub(crate) fn notify_background(app: &tauri::AppHandle, title: &str, body: &str) {
    #[cfg(target_os = "android")]
    mobile::notify(app, title, body);
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Manager;
        use tauri_plugin_notification::NotificationExt;
        if !app
            .get_webview_window("main")
            .is_some_and(|w| w.is_focused().unwrap_or(false))
        {
            let _ = app.notification().builder().title(title).body(body).show();
        }
    }
}
