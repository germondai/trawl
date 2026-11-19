use crate::AppState;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::State;
pub(crate) async fn instance_connection(
    state: &AppState,
    id: &str,
) -> Result<(String, String), String> {
    let cfg = state.core.config();
    if id == "local" {
        let status = state.core.status();
        if status["running"] != true {
            return Err("Start the local server first".into());
        }
        return Ok((
            status["baseURL"]
                .as_str()
                .ok_or("No local server URL")?
                .into(),
            cfg["env"]["API_KEY"].as_str().unwrap_or("").into(),
        ));
    }
    let row = cfg["desktop"]["connections"]
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r["id"] == id))
        .ok_or("Unknown connection")?;
    let base = row["baseURL"].as_str().ok_or("Invalid connection URL")?;
    let url = reqwest::Url::parse(base).map_err(|_| "Invalid connection URL")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid connection URL".into());
    }
    Ok((base.into(), row["apiKey"].as_str().unwrap_or("").into()))
}
#[tauri::command]
pub async fn api_request(
    state: State<'_, Arc<AppState>>,
    instance_id: String,
    path: String,
) -> Result<Value, String> {
    crate::streams::validate_read_path(&path)?;
    let (base, key) = instance_connection(&state, &instance_id).await?;
    let mut response = state
        .http
        .get(format!("{}{}", base.trim_end_matches('/'), path))
        .bearer_auth(key)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "Could not connect to this instance")?;
    let status = response.status().as_u16();
    let mut raw = vec![];
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read instance response")?
    {
        if raw.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("Instance response exceeds its limit".into());
        }
        raw.extend_from_slice(&chunk);
    }
    Ok(
        json!({"status":status,"body":String::from_utf8(raw).map_err(|_|"Invalid response encoding")?}),
    )
}
