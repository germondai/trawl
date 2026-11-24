use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Manager,
};

type Item = MenuItem<tauri::Wry>;
#[derive(Clone)]
enum Parent {
    Menu(Menu<tauri::Wry>),
    Submenu(Submenu<tauri::Wry>),
}
impl Parent {
    fn replace(&self, old: &Item, new: &Item) -> tauri::Result<()> {
        let items = match self {
            Self::Menu(parent) => parent.items()?,
            Self::Submenu(parent) => parent.items()?,
        };
        if let Some(index) = items.iter().position(|item| item.id() == old.id()) {
            match self {
                Self::Menu(parent) => {
                    parent.remove_at(index)?;
                    parent.insert(new, index)?;
                }
                Self::Submenu(parent) => {
                    parent.remove_at(index)?;
                    parent.insert(new, index)?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct Keybindings {
    pub recording: AtomicBool,
    items: Mutex<Vec<(String, Item)>>,
    labels: Mutex<BTreeMap<String, String>>,
    localized_submenus: Mutex<Vec<(Submenu<tauri::Wry>, String)>>,
    localized_predefined: Mutex<Vec<(PredefinedMenuItem<tauri::Wry>, String)>>,
    applied: Mutex<Value>,
    parents: Mutex<Vec<Parent>>,
    update: Mutex<()>,
    #[cfg(target_os = "macos")]
    quit: Mutex<Option<(u16, u64)>>,
}
#[tauri::command]
pub fn set_shortcut_recording(app: tauri::AppHandle, enabled: bool) {
    app.state::<Keybindings>()
        .recording
        .store(enabled, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    crate::shortcuts::cancel(&app);
}
pub fn get(app: &tauri::AppHandle, action: &str) -> Option<Item> {
    app.state::<Keybindings>()
        .items
        .lock()
        .unwrap()
        .iter()
        .find(|(name, _)| name == action)
        .map(|(_, item)| item.clone())
}
pub fn binding(app: &tauri::AppHandle, action: &str) -> Option<String> {
    let state = app.state::<Keybindings>();
    let applied = state.applied.lock().unwrap();
    applied
        .get(action)
        .unwrap_or(&definitions()[action]["default"])
        .as_str()
        .map(str::to_owned)
}
fn definitions() -> &'static Value {
    static DEFINITIONS: OnceLock<Value> = OnceLock::new();
    DEFINITIONS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../packages/config/src/keybindings.json"
        ))
        .expect("shortcut definitions")
    })
}
// The focused WebView owns app shortcuts where the native menu is hidden.
fn uses_native_accelerator(action: &str) -> bool {
    cfg!(target_os = "macos") || definitions()[action]["scope"] == "tray"
}

pub fn item(app: &tauri::AppHandle, action: &str, label: &str) -> tauri::Result<Item> {
    let state = app.state::<Keybindings>();
    let mut items = state.items.lock().unwrap();
    let id = format!("shortcut.{action}.{}", items.len());
    let item = MenuItem::with_id(
        app,
        id.clone(),
        crate::i18n::text(label),
        true,
        definitions()[action]["default"]
            .as_str()
            .filter(|_| uses_native_accelerator(action)),
    )?;
    state.labels.lock().unwrap().insert(id, label.to_owned());
    items.push((action.to_string(), item.clone()));
    Ok(item)
}
fn on_menu_thread(
    app: &tauri::AppHandle,
    work: impl FnOnce(&tauri::AppHandle) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let handle = app.clone();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    // Acquire menu locks only after reaching the UI thread; menu setters also dispatch there.
    app.run_on_main_thread(move || {
        let _ = send.send(work(&handle));
    })
    .map_err(|error| error.to_string())?;
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?
}
pub fn localize(app: &tauri::AppHandle) -> Result<(), String> {
    on_menu_thread(app, localize_on_main)
}
fn localize_on_main(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Keybindings>();
    let _update = state.update.lock().unwrap();
    let labels = state.labels.lock().unwrap().clone();
    for (_, item) in state.items.lock().unwrap().iter() {
        if let Some(key) = labels.get(item.id().as_ref()) {
            item.set_text(crate::i18n::text(key))
                .map_err(|error| error.to_string())?;
        }
    }
    for (submenu, key) in state.localized_submenus.lock().unwrap().iter() {
        submenu
            .set_text(crate::i18n::text(key))
            .map_err(|error| error.to_string())?;
    }
    for (item, key) in state.localized_predefined.lock().unwrap().iter() {
        item.set_text(crate::i18n::text(key))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
pub fn set_label(app: &tauri::AppHandle, action: &str, key: &str) {
    let action = action.to_owned();
    let key = key.to_owned();
    let _ = on_menu_thread(app, move |app| {
        set_label_on_main(app, &action, &key);
        Ok(())
    });
}
fn set_label_on_main(app: &tauri::AppHandle, action: &str, key: &str) {
    let state = app.state::<Keybindings>();
    let _update = state.update.lock().unwrap();
    for (name, item) in state.items.lock().unwrap().iter() {
        if name == action {
            state
                .labels
                .lock()
                .unwrap()
                .insert(item.id().as_ref().to_owned(), key.to_owned());
            let _ = item.set_text(crate::i18n::text(key));
        }
    }
}
pub fn action(app: &tauri::AppHandle, id: &str) -> Option<String> {
    app.state::<Keybindings>()
        .items
        .lock()
        .unwrap()
        .iter()
        .find(|(_, item)| item.id().as_ref() == id)
        .map(|(action, _)| action.clone())
}
pub fn apply(app: &tauri::AppHandle, input: &Value) -> Result<(), String> {
    let input = input.clone();
    on_menu_thread(app, move |app| apply_on_main(app, &input))
}
fn apply_on_main(app: &tauri::AppHandle, input: &Value) -> Result<(), String> {
    let state = app.state::<Keybindings>();
    // Startup config and frontend bootstrap can update menus concurrently.
    let _update = state.update.lock().unwrap();
    let wanted: BTreeMap<String, Option<String>> = definitions()
        .as_object()
        .unwrap()
        .iter()
        .map(|(action, definition)| {
            let value = input
                .get(action)
                .unwrap_or(&definition["default"])
                .as_str()
                .map(str::to_string);
            (action.clone(), value)
        })
        .collect();
    let value = serde_json::to_value(&wanted).unwrap();
    if *state.applied.lock().unwrap() == value {
        return Ok(());
    }
    let items = state.items.lock().unwrap().clone();
    let parents = state.parents.lock().unwrap().clone();
    let previous = state.applied.lock().unwrap().clone();
    for (index, (action, old)) in items.iter().enumerate() {
        if previous
            .get(action)
            .unwrap_or(&definitions()[action]["default"])
            == &value[action]
        {
            continue;
        }
        // muda 0.20 leaves native macOS accelerators active when set to None.
        let fresh = MenuItem::with_id(
            app,
            old.id().clone(),
            old.text().map_err(|e| e.to_string())?,
            old.is_enabled().map_err(|e| e.to_string())?,
            wanted[action]
                .as_deref()
                .filter(|_| uses_native_accelerator(action)),
        )
        .map_err(|e| e.to_string())?;
        for parent in &parents {
            parent.replace(old, &fresh).map_err(|e| e.to_string())?;
        }
        state.items.lock().unwrap()[index].1 = fresh;
    }
    #[cfg(target_os = "macos")]
    {
        *state.quit.lock().unwrap() = wanted["quit"].as_deref().and_then(mac_binding);
        crate::shortcuts::cancel(app);
    }
    *state.applied.lock().unwrap() = value;
    Ok(())
}
pub fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let close_label = PredefinedMenuItem::close_window(app, None)?.text()?;
    let quit_label = PredefinedMenuItem::quit(app, None)?.text()?;
    for parent in menu.items()? {
        if let Some(submenu) = parent.as_submenu() {
            if let Some(key) = default_menu_key(&submenu.text()?) {
                app.state::<Keybindings>()
                    .localized_submenus
                    .lock()
                    .unwrap()
                    .push((submenu.clone(), key.into()));
                submenu.set_text(crate::i18n::text(key))?;
            }
            for (index, child) in submenu.items()?.iter().enumerate() {
                if let Some(child) = child.as_predefined_menuitem() {
                    let label = child.text()?;
                    let replacement = if label == quit_label {
                        Some(("quit", "native.quitTrawl"))
                    } else if label == close_label {
                        Some(("close", "native.closeWindow"))
                    } else {
                        None
                    };
                    if let Some((action, label)) = replacement {
                        submenu.remove_at(index)?;
                        submenu.insert(&item(app, action, label)?, index)?;
                    } else if let Some(key) = default_menu_key(&label) {
                        app.state::<Keybindings>()
                            .localized_predefined
                            .lock()
                            .unwrap()
                            .push((child.clone(), key.into()));
                        child.set_text(crate::i18n::text(key))?;
                    }
                }
            }
        }
    }
    if let Some(parent) = menu
        .items()?
        .first()
        .and_then(|parent| parent.as_submenu())
        .cloned()
    {
        #[cfg(target_os = "macos")]
        parent.set_text("TRAWL")?;
        let index = if cfg!(target_os = "macos") { 2 } else { 0 };
        parent.insert(&item(app, "connections", "ui.appSettings")?, index)?;
        parent.insert(&item(app, "settings", "ui.serverSettings")?, index + 1)?;
    }
    let go = Submenu::new(app, crate::i18n::text("native.go"), true)?;
    app.state::<Keybindings>()
        .localized_submenus
        .lock()
        .unwrap()
        .push((go.clone(), "native.go".into()));
    for action in [
        "overview",
        "history",
        "sessions",
        "workbench",
        "browser",
        "resources",
        "logs",
        "sidebar",
        "refresh",
        "server",
        "restart",
        "search",
    ] {
        go.append(&item(app, action, &format!("shortcuts.{action}.label"))?)?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    go.append(&item(app, "quit", "native.quitTrawl")?)?;
    menu.append(&go)?;
    track_menu(app, &menu)?;
    Ok(menu)
}
fn default_menu_key(label: &str) -> Option<&'static str> {
    let label = label.replace('&', "");
    Some(match label.as_str() {
        "File" => "menu.file",
        "Edit" => "menu.edit",
        "View" => "menu.view",
        "Window" => "menu.window",
        "Help" => "menu.help",
        "Undo" => "menu.undo",
        "Redo" => "menu.redo",
        "Cut" => "menu.cut",
        "Copy" => "menu.copy",
        "Paste" => "menu.paste",
        "Select All" => "menu.selectAll",
        "Minimize" => "menu.minimize",
        "Maximize" | "Zoom" => "menu.zoom",
        "Toggle Fullscreen" | "Toggle Full Screen" | "Enter Full Screen" | "Full Screen" => {
            "menu.fullscreen"
        }
        "Services" => "menu.services",
        "Hide Others" => "menu.hideOthers",
        "Show All" | "Show Everything" => "menu.showAll",
        value if value == "About" || value.starts_with("About ") => "menu.about",
        value if value == "Hide" || value.starts_with("Hide ") => "menu.hideApp",
        _ => return None,
    })
}
pub fn track_menu(app: &tauri::AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    fn submenus(parent: &Submenu<tauri::Wry>, output: &mut Vec<Parent>) -> tauri::Result<()> {
        output.push(Parent::Submenu(parent.clone()));
        for item in parent.items()? {
            if let Some(child) = item.as_submenu() {
                submenus(child, output)?;
            }
        }
        Ok(())
    }
    let mut parents = vec![Parent::Menu(menu.clone())];
    for item in menu.items()? {
        if let Some(parent) = item.as_submenu() {
            submenus(parent, &mut parents)?;
        }
    }
    app.state::<Keybindings>()
        .parents
        .lock()
        .unwrap()
        .extend(parents);
    Ok(())
}
#[cfg(target_os = "macos")]
const MAC_KEYS: &[(&str, u16)] = &[
    ("A", 0),
    ("S", 1),
    ("D", 2),
    ("F", 3),
    ("H", 4),
    ("G", 5),
    ("Z", 6),
    ("X", 7),
    ("C", 8),
    ("V", 9),
    ("B", 11),
    ("Q", 12),
    ("W", 13),
    ("E", 14),
    ("R", 15),
    ("Y", 16),
    ("T", 17),
    ("1", 18),
    ("2", 19),
    ("3", 20),
    ("4", 21),
    ("6", 22),
    ("5", 23),
    ("=", 24),
    ("9", 25),
    ("7", 26),
    ("-", 27),
    ("8", 28),
    ("0", 29),
    ("]", 30),
    ("O", 31),
    ("U", 32),
    ("[", 33),
    ("I", 34),
    ("P", 35),
    ("Enter", 36),
    ("L", 37),
    ("J", 38),
    ("'", 39),
    ("K", 40),
    (";", 41),
    ("\\", 42),
    (",", 43),
    ("/", 44),
    ("N", 45),
    ("M", 46),
    (".", 47),
    ("Tab", 48),
    ("Space", 49),
    ("`", 50),
    ("Backspace", 51),
    ("Escape", 53),
    ("F1", 122),
    ("F2", 120),
    ("F3", 99),
    ("F4", 118),
    ("F5", 96),
    ("F6", 97),
    ("F7", 98),
    ("F8", 100),
    ("F9", 101),
    ("F10", 109),
    ("F11", 103),
    ("F12", 111),
    ("Delete", 117),
    ("Home", 115),
    ("End", 119),
    ("PageUp", 116),
    ("PageDown", 121),
    ("ArrowLeft", 123),
    ("ArrowRight", 124),
    ("ArrowDown", 125),
    ("ArrowUp", 126),
];
#[cfg(target_os = "macos")]
fn mac_binding(value: &str) -> Option<(u16, u64)> {
    let parts: Vec<_> = value.split('+').collect();
    let key = parts.last()?;
    let code = MAC_KEYS.iter().find(|(name, _)| name == key)?.1;
    let modifiers = (1 << 20)
        | if parts.contains(&"Alt") { 1 << 19 } else { 0 }
        | if parts.contains(&"Shift") { 1 << 17 } else { 0 };
    Some((code, modifiers))
}
#[cfg(target_os = "macos")]
pub fn recorded_key(key: u16, flags: u64) -> Option<String> {
    if flags & ((1 << 20) | (1 << 18)) != 1 << 20 {
        return None;
    }
    let name = MAC_KEYS.iter().find(|(_, code)| *code == key)?.0;
    Some(format!(
        "CmdOrCtrl+{}{}{}",
        if flags & (1 << 19) != 0 { "Alt+" } else { "" },
        if flags & (1 << 17) != 0 { "Shift+" } else { "" },
        name
    ))
}
#[cfg(target_os = "macos")]
pub fn quit_matches(app: &tauri::AppHandle, key: u16, flags: u64) -> bool {
    app.state::<Keybindings>()
        .quit
        .lock()
        .unwrap()
        .is_some_and(|(code, modifiers)| {
            code == key && flags & ((1 << 20) | (1 << 19) | (1 << 18) | (1 << 17)) == modifiers
        })
}
#[cfg(target_os = "macos")]
pub fn quit_modifiers_held(app: &tauri::AppHandle, flags: u64) -> bool {
    app.state::<Keybindings>()
        .quit
        .lock()
        .unwrap()
        .is_some_and(|(_, modifiers)| flags & modifiers == modifiers)
}
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn custom_quit_keys_keep_modifiers_and_physical_key_codes() {
        assert_eq!(mac_binding("CmdOrCtrl+Q"), Some((12, 1 << 20)));
        assert_eq!(
            mac_binding("CmdOrCtrl+Alt+Shift+N"),
            Some((45, (1 << 20) | (1 << 19) | (1 << 17)))
        );
        assert_eq!(mac_binding("CmdOrCtrl+2"), Some((19, 1 << 20)));
        assert_eq!(mac_binding("CmdOrCtrl+F12"), Some((111, 1 << 20)));
        assert_eq!(mac_binding("CmdOrCtrl+Unknown"), None);
    }
    #[test]
    fn recording_keeps_physical_keys_and_requires_command() {
        assert_eq!(
            recorded_key(45, (1 << 20) | (1 << 17)),
            Some("CmdOrCtrl+Shift+N".into())
        );
        assert_eq!(recorded_key(53, 1 << 20), Some("CmdOrCtrl+Escape".into()));
        assert_eq!(recorded_key(45, 1 << 18), None);
        assert_eq!(recorded_key(55, 1 << 20), None);
    }
}
