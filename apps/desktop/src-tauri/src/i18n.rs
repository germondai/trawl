use serde_json::Value;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex, OnceLock,
};

const LOCALES: [&str; 6] = ["en", "cs", "sk", "pl", "de", "fr"];
static LANGUAGE: AtomicUsize = AtomicUsize::new(0);
static PREFERENCE: Mutex<String> = Mutex::new(String::new());
fn catalogs() -> &'static [Value; 6] {
    static CATALOGS: OnceLock<[Value; 6]> = OnceLock::new();
    CATALOGS.get_or_init(|| {
        [
            include_str!("../../../../packages/config/locales/en.json"),
            include_str!("../../../../packages/config/locales/cs.json"),
            include_str!("../../../../packages/config/locales/sk.json"),
            include_str!("../../../../packages/config/locales/pl.json"),
            include_str!("../../../../packages/config/locales/de.json"),
            include_str!("../../../../packages/config/locales/fr.json"),
        ]
        .map(|text| serde_json::from_str(text).expect("bundled locale catalog"))
    })
}
pub fn resolve(language: &str, preferred: &[String]) -> usize {
    if language != "system" {
        return LOCALES
            .iter()
            .position(|locale| *locale == language)
            .unwrap_or(0);
    }
    preferred
        .iter()
        .find_map(|value| {
            let base = value.split(['-', '_']).next().unwrap_or("").to_lowercase();
            LOCALES.iter().position(|locale| *locale == base)
        })
        .unwrap_or(0)
}
fn preferred_languages() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        return objc2_foundation::NSLocale::preferredLanguages()
            .iter()
            .map(|value| value.to_string())
            .collect();
    }
    #[cfg(target_os = "windows")]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetUserDefaultLocaleName(name: *mut u16, length: i32) -> i32;
        }
        let mut name = [0u16; 85];
        let length = unsafe { GetUserDefaultLocaleName(name.as_mut_ptr(), name.len() as i32) };
        return if length > 1 {
            vec![String::from_utf16_lossy(&name[..length as usize - 1])]
        } else {
            Vec::new()
        };
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .filter_map(|key| std::env::var(key).ok())
            .flat_map(|value| value.split(':').map(str::to_owned).collect::<Vec<_>>())
            .collect()
    }
}
pub fn set_language(language: &str) -> bool {
    let mut preference = PREFERENCE.lock().unwrap();
    *preference = language.to_owned();
    let next = resolve(language, &preferred_languages());
    LANGUAGE.swap(next, Ordering::SeqCst) != next
}
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn refresh_app_language(app: tauri::AppHandle) -> Result<(), String> {
    let preference = PREFERENCE.lock().unwrap();
    if preference.as_str() == "system" {
        let next = resolve("system", &preferred_languages());
        let changed = LANGUAGE.swap(next, Ordering::SeqCst) != next;
        drop(preference);
        if changed {
            crate::keybindings::localize(&app)?;
            crate::tray::render_instances(&app).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
pub fn text(key: &str) -> String {
    let catalogs = catalogs();
    catalogs[LANGUAGE.load(Ordering::SeqCst)][key]
        .as_str()
        .or_else(|| catalogs[0][key].as_str())
        .unwrap_or(key)
        .to_owned()
}
pub fn locale() -> &'static str {
    LOCALES[LANGUAGE.load(Ordering::SeqCst)]
}
pub fn format(key: &str, arguments: &[(&str, &str)]) -> String {
    let message = text(key);
    let mut result = String::with_capacity(message.len());
    let mut remaining = message.as_str();
    // Interpolate once; user-provided braces must not become another placeholder.
    while let Some(start) = remaining.find('{') {
        result.push_str(&remaining[..start]);
        let Some(end) = remaining[start..].find('}').map(|end| start + end) else {
            result.push_str(&remaining[start..]);
            return result;
        };
        let name = &remaining[start + 1..end];
        result.push_str(
            arguments
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| *value)
                .unwrap_or(&remaining[start..=end]),
        );
        remaining = &remaining[end + 1..];
    }
    result.push_str(remaining);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_supported_languages_and_falls_back_without_changing_preference() {
        assert_eq!(resolve("en", &["cs-CZ".into()]), 0);
        assert_eq!(resolve("system", &["ja".into(), "cs-CZ".into()]), 1);
        assert_eq!(resolve("system", &["de_AT".into()]), 4);
        assert_eq!(resolve("unsupported", &[]), 0);
    }
    #[test]
    fn interpolated_values_are_not_reinterpreted() {
        assert_eq!(
            format("native.instance", &[("name", "{name}")]),
            "Instance: {name}"
        );
    }
}
