use std::path::Path;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath};

#[tauri::command]
pub async fn choose_setting_path(
    app: tauri::AppHandle,
    name: String,
    current: String,
) -> Result<Option<String>, String> {
    let directory = match name.as_str() {
        "MITM_CA_DIR" => true,
        "METRICS_DB_PATH" | "PROXY_LIST_FILE" | "RESIDENTIAL_PROXY_LIST_FILE" | "FFMPEG_PATH" => {
            false
        }
        _ => return Err("This setting has no filesystem picker".into()),
    };
    if current.len() > 4096 {
        return Err("The current path is too long".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("The main window is unavailable")?;
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(crate::i18n::text(if directory {
            "native.chooseDirectory"
        } else {
            "native.chooseFile"
        }));
    let path = Path::new(&current);
    if !current.is_empty() {
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        } else if let Some(parent) = path.parent().filter(|parent| parent.is_dir()) {
            dialog = dialog.set_directory(parent);
        }
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    if directory {
        dialog.pick_folder(move |path| {
            let _ = send.send(path);
        });
    } else {
        dialog.pick_file(move |path| {
            let _ = send.send(path);
        });
    }
    match receive
        .await
        .map_err(|_| "The filesystem picker closed unexpectedly")?
    {
        Some(FilePath::Path(path)) => Ok(Some(path.to_string_lossy().into_owned())),
        Some(FilePath::Url(_)) => Err("Select a local filesystem path".into()),
        None => Ok(None),
    }
}
