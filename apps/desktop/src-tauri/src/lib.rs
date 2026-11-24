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
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            mobile::sync_state(&handle).await;
        });
    }
    if notify {
        notify_background(
            app,
            if success {
                "native.requestCompleted"
            } else {
                "native.requestFailed"
            },
            "native.openResult",
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
            let _ = app
                .notification()
                .builder()
                .title(i18n::text(title))
                .body(i18n::text(body))
                .show();
        }
    }
}
#[cfg(not(target_os = "android"))]
mod i18n;
#[tauri::command]
async fn app_locale(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        mobile::app_locale(&app).await
    }
    #[cfg(not(target_os = "android"))]
    {
        i18n::refresh_app_language(app)?;
        Ok(i18n::locale().to_owned())
    }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum InteractionFeedback {
    Press,
    Navigate,
    Success,
    Error,
}

#[tauri::command]
async fn interaction_haptic(
    app: tauri::AppHandle,
    feedback: InteractionFeedback,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        mobile::interaction_haptic(&app, feedback).await
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{
            NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
            NSHapticFeedbackPerformer,
        };
        let pattern = match feedback {
            InteractionFeedback::Press | InteractionFeedback::Error => {
                NSHapticFeedbackPattern::Generic
            }
            InteractionFeedback::Navigate => NSHapticFeedbackPattern::Alignment,
            InteractionFeedback::Success => NSHapticFeedbackPattern::LevelChange,
        };
        app.run_on_main_thread(move || {
            NSHapticFeedbackManager::defaultPerformer().performFeedbackPattern_performanceTime(
                pattern,
                NSHapticFeedbackPerformanceTime::Now,
            );
        })
        .map_err(|error| error.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "macos")))]
    {
        let _ = (app, feedback);
        Ok(())
    }
}

#[cfg(not(target_os = "android"))]
mod setting_paths;
mod updates;

// Keep the bundled Mozilla trust store when upgrading reqwest's default verifier.
pub(crate) fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().tls_certs_only(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().map(
        |cert| reqwest::Certificate::from_der(cert.as_ref()).expect("bundled root certificate"),
    ))
}
