use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, WebviewWindow};

#[cfg(target_os = "macos")]
thread_local! {
    static DRAG_EVENT: std::cell::RefCell<Option<(objc2::rc::Retained<objc2_app_kit::NSEvent>, f64)>> = const { std::cell::RefCell::new(None) };
    static LAST_MOUSE_DOWN: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
}

#[derive(serde::Deserialize)]
pub struct DragTimestamp {
    earliest: f64,
    latest: f64,
}
impl DragTimestamp {
    fn matches(&self, current: f64, previous: f64) -> bool {
        self.earliest.is_finite()
            && self.latest.is_finite()
            && self.earliest >= 0.0
            && self.latest >= self.earliest
            && self.latest - self.earliest <= 0.05
            && (self.earliest..=self.latest).contains(&current)
            && !(self.earliest..=self.latest).contains(&previous)
    }
}

#[cfg(target_os = "macos")]
pub fn mouse_event(app: &tauri::AppHandle, event: &objc2_app_kit::NSEvent) {
    use objc2_app_kit::{NSApplication, NSEventType, NSWindow};
    if ![NSEventType::LeftMouseDown, NSEventType::LeftMouseUp].contains(&event.r#type()) {
        return;
    }
    DRAG_EVENT.with(|saved| {
        saved.borrow_mut().take();
        let previous = if event.r#type() == NSEventType::LeftMouseDown {
            LAST_MOUSE_DOWN.with(|last| last.replace(event.timestamp()))
        } else {
            return;
        };
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let Ok(pointer) = window.ns_window() else {
            return;
        };
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        if event.r#type() == NSEventType::LeftMouseDown
            && NSApplication::sharedApplication(mtm).isActive()
            && native.isKeyWindow()
            && event.windowNumber() == native.windowNumber()
        {
            // Preserve the original window-relative event across the asynchronous WebView call.
            *saved.borrow_mut() =
                unsafe { objc2::rc::Retained::retain(std::ptr::from_ref(event).cast_mut()) }
                    .map(|event| (event, previous));
        }
    });
}

#[tauri::command]
pub fn native_window_drag(
    window: WebviewWindow,
    document_id: u64,
    timestamp: Option<DragTimestamp>,
) -> Result<(), String> {
    let session = document_session(&window, document_id)?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = session;
        let _ = timestamp;
        window.start_dragging().map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        window
            .run_on_main_thread(move || {
                if !app.state::<WindowChrome>().accepts(&session, document_id) {
                    return;
                }
                DRAG_EVENT.with(|saved| {
                    let mut saved = saved.borrow_mut();
                    let Some((event, previous)) = saved.as_ref() else {
                        return;
                    };
                    if !timestamp
                        .as_ref()
                        .is_some_and(|time| time.matches(event.timestamp(), *previous))
                    {
                        return;
                    }
                    let (event, _) = saved.take().unwrap();
                    drop(saved);
                    if objc2_app_kit::NSEvent::pressedMouseButtons() & 1 == 0 {
                        return;
                    }
                    let Some(window) = app.get_webview_window("main") else {
                        return;
                    };
                    let Ok(pointer) = window.ns_window() else {
                        return;
                    };
                    let native = unsafe { &*pointer.cast::<objc2_app_kit::NSWindow>() };
                    if native.isKeyWindow() && event.windowNumber() == native.windowNumber() {
                        native.performWindowDragWithEvent(&event);
                    }
                });
            })
            .map_err(|e| e.to_string())
    }
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromePosition {
    x: f64,
    center_y: f64,
    #[serde(default)]
    hidden: bool,
}

struct Session {
    document: AtomicU64,
    mutation: Mutex<()>,
    ready: AtomicBool,
    shown: AtomicBool,
    prepared: AtomicBool,
    initialized: AtomicBool,
    position: Mutex<Option<ChromePosition>>,
    #[cfg(target_os = "macos")]
    button_spacing: Mutex<Option<f64>>,
}
impl Session {
    fn finish_preparation(&self) -> bool {
        self.ready.load(Ordering::SeqCst) && !self.prepared.swap(true, Ordering::SeqCst)
    }
}
#[derive(Default)]
pub struct WindowChrome {
    sequence: AtomicU64,
    current: Mutex<Option<Arc<Session>>>,
}
impl WindowChrome {
    fn session(&self) -> Arc<Session> {
        self.current
            .lock()
            .unwrap()
            .get_or_insert_with(|| {
                Arc::new(Session {
                    document: AtomicU64::new(self.sequence.fetch_add(1, Ordering::SeqCst) + 1),
                    mutation: Mutex::new(()),
                    ready: AtomicBool::new(false),
                    shown: AtomicBool::new(false),
                    prepared: AtomicBool::new(false),
                    initialized: AtomicBool::new(false),
                    position: Mutex::new(None),
                    #[cfg(target_os = "macos")]
                    button_spacing: Mutex::new(None),
                })
            })
            .clone()
    }
    fn accepts(&self, session: &Arc<Session>, document: u64) -> bool {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
            && session.document.load(Ordering::SeqCst) == document
    }
}
fn check_window(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let trusted = url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || ["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost")
        || cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1421);
    if window.label() != "main" || !trusted {
        return Err("Untrusted window".into());
    }
    Ok(())
}
fn document_session(window: &WebviewWindow, document_id: u64) -> Result<Arc<Session>, String> {
    check_window(window)?;
    let state = window.state::<WindowChrome>();
    let session = state.session();
    if !state.accepts(&session, document_id) {
        return Err("Stale window document".into());
    }
    Ok(session)
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeDocument {
    document_id: u64,
    monotonic_time: Option<f64>,
}
#[tauri::command]
pub fn native_window_document(window: WebviewWindow) -> Result<ChromeDocument, String> {
    check_window(&window)?;
    let document_id = window
        .state::<WindowChrome>()
        .session()
        .document
        .load(Ordering::SeqCst);
    Ok(ChromeDocument {
        document_id,
        monotonic_time: {
            #[cfg(target_os = "macos")]
            {
                Some(objc2_foundation::NSProcessInfo::processInfo().systemUptime())
            }
            #[cfg(not(target_os = "macos"))]
            {
                None
            }
        },
    })
}
#[tauri::command]
pub fn native_window_chrome(
    window: WebviewWindow,
    document_id: u64,
    position: ChromePosition,
) -> Result<(), String> {
    let session = document_session(&window, document_id)?;
    let _mutation = session.mutation.lock().unwrap();
    if session.document.load(Ordering::SeqCst) != document_id {
        return Err("Stale window document".into());
    }
    if !position.x.is_finite()
        || !position.center_y.is_finite()
        || !(0.0..=100_000.0).contains(&position.x)
        || !(0.0..=100_000.0).contains(&position.center_y)
    {
        return Err("Invalid window controls position".into());
    }
    *session.position.lock().unwrap() = Some(position);
    update(&window).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn native_window_ready(window: WebviewWindow, document_id: u64) -> Result<(), String> {
    let session = document_session(&window, document_id)?;
    let _mutation = session.mutation.lock().unwrap();
    if session.document.load(Ordering::SeqCst) != document_id {
        return Err("Stale window document".into());
    }
    if cfg!(target_os = "macos") && session.position.lock().unwrap().is_none() {
        return Err("Window controls have not been measured".into());
    }
    session.ready.store(true, Ordering::SeqCst);
    update(&window).map_err(|e| e.to_string())
}
pub fn setup(window: &WebviewWindow) -> tauri::Result<()> {
    let session = window.state::<WindowChrome>().session();
    if !session.initialized.swap(true, Ordering::SeqCst) {
        #[cfg(target_os = "macos")]
        crate::window_state::setup(window)?;
        #[cfg(target_os = "macos")]
        crate::history_gesture::setup(window)?;
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        window.hide_menu()?;
        #[cfg(target_os = "windows")]
        window.set_decorations(false)?;
        update(window)?;
        loaded(window);
    }
    Ok(())
}
pub fn loading(window: &WebviewWindow) {
    let state = window.state::<WindowChrome>();
    let session = state.session();
    let _mutation = session.mutation.lock().unwrap();
    session.document.store(
        state.sequence.fetch_add(1, Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    session.ready.store(false, Ordering::SeqCst);
    session.shown.store(false, Ordering::SeqCst);
    session.prepared.store(false, Ordering::SeqCst);
    *session.position.lock().unwrap() = None;
    let _ = window.hide();
    let _ = update(window);
    loaded(window);
}
pub fn loaded(window: &WebviewWindow) {
    let session = window.state::<WindowChrome>().session();
    let document = session.document.load(Ordering::SeqCst);
    let app = window.app_handle().clone();
    // Keep only a weak session: destroyed WebViews must not survive their recovery timer.
    let session = Arc::downgrade(&session);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        let dispatcher = app.clone();
        let _ = dispatcher.run_on_main_thread(move || {
            let Some(session) = session.upgrade() else { return; };
            if !app.state::<WindowChrome>().accepts(&session, document) || session.ready.load(Ordering::SeqCst) || session.shown.load(Ordering::SeqCst) { return; }
            if let Some(window) = app.get_webview_window("main") {
                eprintln!("TRAWL window readiness timed out; showing recovery window");
                let labels = serde_json::json!({"message": crate::i18n::text("native.windowRecovery"), "reload": crate::i18n::text("native.reload")});
                let _ = window.eval(format!("(() => {{ const labels = {}; ", labels) + "if (!document.getElementById('native-recovery')) { const p=document.createElement('div'); p.id='native-recovery'; p.style.cssText='visibility:visible;position:fixed;inset:0;z-index:99999;background:#1c1c1e;color:#eee;padding:64px;font:16px system-ui'; p.textContent=labels.message+' '; const b=document.createElement('button'); b.textContent=labels.reload; b.onclick=()=>location.reload(); p.append(b); document.body.append(p); } })()");
                session.shown.store(true, Ordering::SeqCst);
                let _ = update(&window);
                #[cfg(target_os = "macos")]
                crate::runtime::window_dock_visibility(&app, true);
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
    });
}
pub fn ready(app: &tauri::AppHandle) -> bool {
    app.state::<WindowChrome>()
        .current
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|session| session.ready.load(Ordering::SeqCst))
}
pub fn reopen(window: &WebviewWindow) {
    if window
        .state::<WindowChrome>()
        .session()
        .shown
        .load(Ordering::SeqCst)
    {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
pub fn destroyed(app: &tauri::AppHandle) {
    *app.state::<WindowChrome>().current.lock().unwrap() = None;
    #[cfg(target_os = "macos")]
    crate::window_state::shutdown();
    #[cfg(target_os = "macos")]
    crate::history_gesture::shutdown();
    #[cfg(target_os = "macos")]
    DRAG_EVENT.with(|saved| saved.borrow_mut().take());
    #[cfg(target_os = "macos")]
    LAST_MOUSE_DOWN.with(|last| last.set(0.0));
}
pub fn update(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle().clone();
    let session = window.state::<WindowChrome>().session();
    let document = session.document.load(Ordering::SeqCst);
    let apply = move || {
        if !app.state::<WindowChrome>().accepts(&session, document) {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        #[cfg(target_os = "macos")]
        position_controls(&window, &session);
        if session.finish_preparation() {
            let _ = window.eval("document.getElementById('native-recovery')?.remove()");
        }
        if session.ready.load(Ordering::SeqCst) && !session.shown.swap(true, Ordering::SeqCst) {
            #[cfg(target_os = "macos")]
            crate::runtime::window_dock_visibility(&app, true);
            if let Err(error) = window.show().and_then(|_| window.set_focus()) {
                session.shown.store(false, Ordering::SeqCst);
                eprintln!("Cannot reveal TRAWL: {error}");
            }
        }
    };
    // AppKit resize/layout notifications must be corrected before the next draw.
    #[cfg(target_os = "macos")]
    if objc2::MainThreadMarker::new().is_some() {
        apply();
        return Ok(());
    }
    window.run_on_main_thread(apply)
}
#[cfg(target_os = "macos")]
fn position_controls(window: &WebviewWindow, session: &Session) {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
    unsafe {
        let Ok(pointer) = window.ns_window() else {
            return;
        };
        if pointer.is_null() {
            return;
        }
        let native = &*pointer.cast::<NSWindow>();
        if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
            return;
        }
        let [Some(close), Some(minimize), Some(zoom)] = [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ]
        .map(|kind| native.standardWindowButton(kind)) else {
            return;
        };
        for button in [&close, &minimize, &zoom] {
            let ready = session.ready.load(Ordering::SeqCst);
            let hidden = !ready && !session.shown.load(Ordering::SeqCst)
                || ready && session
                    .position
                    .lock()
                    .unwrap()
                    .is_some_and(|position| position.hidden);
            if button.isHidden() != hidden {
                button.setHidden(hidden);
            }
        }
        let Some(ChromePosition { x, center_y, .. }) = *session.position.lock().unwrap() else {
            return;
        };
        let Some(bar) = close.superview().and_then(|view| view.superview()) else {
            return;
        };
        let close_frame = close.frame();
        let spacing = *session
            .button_spacing
            .lock()
            .unwrap()
            .get_or_insert_with(|| minimize.frame().origin.x - close_frame.origin.x);
        let mut frame = bar.frame();
        frame.size.height = center_y + close_frame.origin.y + close_frame.size.height / 2.0;
        frame.origin.y = native.frame().size.height - frame.size.height;
        if bar.frame() != frame {
            bar.setFrame(frame);
        }
        for (index, button) in [&close, &minimize, &zoom].iter().enumerate() {
            let mut origin = button.frame().origin;
            origin.x = x + index as f64 * spacing;
            origin.y =
                close_frame.origin.y + (close_frame.size.height - button.frame().size.height) / 2.0;
            if button.frame().origin != origin {
                button.setFrameOrigin(origin);
            }
        }
        if cfg!(debug_assertions) && std::env::var_os("TRAWL_WINDOW_PROFILE").is_some() {
            let actual = close.frame();
            eprintln!(
                "TRAWL_WINDOW {}",
                serde_json::json!({ "ready": session.ready.load(Ordering::SeqCst), "target": { "x": x, "centerY": center_y }, "actual": { "x": actual.origin.x, "centerY": native.frame().size.height - bar.frame().origin.y - actual.origin.y - actual.size.height / 2.0 }, "scale": native.backingScaleFactor() })
            );
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delayed_drag_cannot_consume_a_later_or_ambiguous_mouse_gesture() {
        let first = DragTimestamp {
            earliest: 99.999,
            latest: 100.001,
        };
        assert!(first.matches(100.0, 99.5));
        assert!(!first.matches(100.02, 100.0));
        assert!(!first.matches(100.0005, 100.0));
        assert!(DragTimestamp {
            earliest: 100.019,
            latest: 100.021
        }
        .matches(100.02, 100.0));
        assert!(!DragTimestamp {
            earliest: f64::NAN,
            latest: 100.0
        }
        .matches(100.0, 99.5));
    }
    #[test]
    fn recovery_cannot_reveal_a_destroyed_or_replaced_document() {
        let state = WindowChrome::default();
        let first = state.session();
        let id = first.document.load(Ordering::SeqCst);
        assert!(state.accepts(&first, id));
        first.document.fetch_add(1, Ordering::SeqCst);
        assert!(!state.accepts(&first, id));
        *state.current.lock().unwrap() = None;
        let second = state.session();
        assert!(!state.accepts(&first, second.document.load(Ordering::SeqCst)));
        assert!(state.accepts(&second, second.document.load(Ordering::SeqCst)));
    }
    #[test]
    fn late_readiness_finishes_preparation_even_after_recovery_shows_the_window() {
        let state = WindowChrome::default();
        let session = state.session();
        session.shown.store(true, Ordering::SeqCst);
        assert!(!session.finish_preparation());
        session.ready.store(true, Ordering::SeqCst);
        assert!(session.finish_preparation());
        assert!(!session.finish_preparation());
    }
}
