use block2::RcBlock;
use objc2::{
    msg_send,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{NSApplication, NSApplicationDidResignActiveNotification};
use objc2_foundation::{NSNotificationCenter, NSOperationQueue};
use std::sync::{atomic::Ordering, Arc};
use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
}

#[derive(Default)]
struct QuitHold {
    pressed: Option<(u16, Instant)>,
    first_press: Option<Instant>,
    pending: Option<u64>,
    generation: u64,
    cancelled_key: Option<u16>,
}
impl QuitHold {
    fn press(&mut self, key: u16, now: Instant, mode: u8) -> &'static str {
        if self.cancelled_key == Some(key) {
            return "cancelled";
        }
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        match mode {
            0 => "quit",
            1 => {
                if self
                    .first_press
                    .take()
                    .is_some_and(|first| now.duration_since(first) <= Duration::from_millis(750))
                {
                    "quit"
                } else {
                    self.first_press = Some(now);
                    "double"
                }
            }
            _ => {
                self.pressed = Some((key, now));
                "hold"
            }
        }
    }
    fn cancel_key(&mut self, kind: usize, key: u16) -> bool {
        if kind == 10
            && key == 53
            && (self.pressed.is_some()
                || self.first_press.is_some()
                || self.pending.is_some()
                || self.cancelled_key.is_some())
        {
            self.cancel_held();
            true
        } else {
            false
        }
    }
    fn cancel(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.pressed = None;
        self.first_press = None;
        self.cancelled_key = None;
    }
    // Escape cancels this physical chord, including any further keyDown delivery before release.
    fn cancel_held(&mut self) {
        let key = self.pressed.map(|(key, _)| key).or(self.cancelled_key);
        self.cancel();
        self.cancelled_key = key;
    }
    fn observe_escape(&mut self, generation: u64, pressed: bool) -> bool {
        if self.generation == generation
            && self.pressed.is_some_and(|(key, _)| key != 53)
            && pressed
        {
            self.cancel_held();
            true
        } else {
            false
        }
    }
    fn suppress_cancelled(&mut self, kind: usize, key: u16, modifiers_held: bool) -> bool {
        let Some(cancelled) = self.cancelled_key else {
            return false;
        };
        if (kind == 11 && key == cancelled) || (kind == 12 && !modifiers_held) {
            self.cancelled_key = None;
        }
        kind == 10 && key == cancelled
    }
    fn defer(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.pending = Some(self.generation);
        self.generation
    }
    fn finish(&mut self, ticket: u64) -> bool {
        if self.pending == Some(ticket) {
            self.pending = None;
            true
        } else {
            false
        }
    }
    fn release_with_escape(&mut self, now: Instant, escape_down: bool) -> bool {
        if escape_down && self.pressed.is_some_and(|(key, _)| key != 53) {
            self.cancel();
            false
        } else {
            self.release(now)
        }
    }
    fn release(&mut self, now: Instant) -> bool {
        self.pressed
            .take()
            .is_some_and(|(_, started)| now.duration_since(started) >= Duration::from_secs(1))
    }
}
static HOLD: Mutex<QuitHold> = Mutex::new(QuitHold {
    pressed: None,
    first_press: None,
    pending: None,
    generation: 0,
    cancelled_key: None,
});
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
type SendEvent = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);
static ORIGINAL: OnceLock<SendEvent> = OnceLock::new();

pub fn cancel(app: &tauri::AppHandle) {
    let mut hold = HOLD.lock().unwrap();
    hold.cancel();
    drop(hold);
    let _ = app.emit("quit-feedback", "");
}
pub fn cancel_gesture(app: &tauri::AppHandle) {
    HOLD.lock().unwrap().cancel_held();
    let _ = app.emit("quit-feedback", "");
}
fn escape_pressed() -> bool {
    unsafe { CGEventSourceKeyState(0, 53) || CGEventSourceKeyState(1, 53) }
}
fn watch_escape(app: tauri::AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(16)).await;
            let cancelled = {
                let mut hold = HOLD.lock().unwrap();
                if hold.generation != generation || hold.pressed.is_none() {
                    return;
                }
                // A system/global Cmd+Escape shortcut can consume NSEvent delivery. Read only
                // Escape, and only while this application's Quit chord is active.
                let pressed = escape_pressed();
                hold.observe_escape(generation, pressed)
            };
            if cancelled {
                let _ = app.emit("quit-feedback", "");
                return;
            }
        }
    });
}

unsafe extern "C-unwind" fn send_event(
    application: *mut AnyObject,
    selector: Sel,
    event: *mut AnyObject,
) {
    let app = APP.get().unwrap();
    let kind: usize = msg_send![event, type];
    if kind == 1 || kind == 2 {
        crate::window_chrome::mouse_event(app, &*event.cast::<objc2_app_kit::NSEvent>());
    }
    if kind == 25 || kind == 26 {
        let button: isize = msg_send![event, buttonNumber];
        if [3, 4].contains(&button)
            && app
                .get_webview_window("main")
                .is_some_and(|window| window.is_focused().unwrap_or(false))
        {
            if kind == 26 {
                let _ = app.emit(
                    "navigate-requested",
                    if button == 3 { "back" } else { "forward" },
                );
            }
            return;
        }
    }
    if [10, 11, 12].contains(&kind) {
        let flags: usize = msg_send![event, modifierFlags];
        let key: u16 = msg_send![event, keyCode];
        if HOLD.lock().unwrap().cancel_key(kind, key) {
            let _ = app.emit("quit-feedback", "");
            return;
        }
        if HOLD.lock().unwrap().suppress_cancelled(
            kind,
            key,
            crate::keybindings::quit_modifiers_held(app, flags as u64),
        ) {
            return;
        }
        if app
            .state::<crate::keybindings::Keybindings>()
            .recording
            .load(Ordering::SeqCst)
        {
            if kind == 10 {
                let cancel =
                    key == 53 && flags & ((1 << 20) | (1 << 19) | (1 << 18) | (1 << 17)) == 0;
                let _ = app.emit("shortcut-recorded", serde_json::json!({"cancel":cancel,"shortcut":crate::keybindings::recorded_key(key, flags as u64)}));
            }
            if kind == 10 || kind == 11 {
                return;
            }
        }
        if kind == 10 && key == 48 && flags & ((1 << 20) | (1 << 19) | (1 << 18)) == 1 << 18 {
            let _ = app.emit(
                "navigate-requested",
                if flags & (1 << 17) == 0 {
                    "next-page"
                } else {
                    "previous-page"
                },
            );
            return;
        }
        let mut hold = HOLD.lock().unwrap();
        if let Some((pressed_key, _)) = hold.pressed {
            if (kind == 11 && key == pressed_key)
                || (kind == 12 && !crate::keybindings::quit_modifiers_held(app, flags as u64))
            {
                if hold.release_with_escape(Instant::now(), escape_pressed()) {
                    let ticket = hold.defer();
                    drop(hold);
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        let dispatcher = app.clone();
                        let _ = dispatcher.run_on_main_thread(move || {
                            if HOLD.lock().unwrap().finish(ticket) {
                                let _ = app.emit("quit-feedback", "");
                                crate::request_quit(&app);
                            }
                        });
                    });
                } else {
                    drop(hold);
                    let _ = app.emit("quit-feedback", "");
                }
                return;
            }
        }
        let quitting_key = kind == 10 && crate::keybindings::quit_matches(app, key, flags as u64);
        if kind == 10 && key == 53 && !quitting_key {
            drop(hold);
            cancel(app);
        } else if quitting_key {
            let repeat: bool = msg_send![event, isARepeat];
            if !repeat && hold.pressed.is_none() {
                let mode = app
                    .state::<Arc<crate::AppState>>()
                    .quit_behavior
                    .load(Ordering::SeqCst);
                let action = hold.press(key, Instant::now(), mode);
                let generation = hold.generation;
                drop(hold);
                if action == "quit" {
                    cancel(app);
                    crate::request_quit(app);
                } else if action != "cancelled" {
                    let _ = app.emit("quit-feedback", action);
                    if action == "hold" {
                        watch_escape(app.clone(), generation);
                    }
                }
            }
            return;
        }
    }
    if let Some(original) = ORIGINAL.get() {
        original(application, selector, event);
    }
}

pub fn setup(app: tauri::AppHandle) {
    if APP.set(app).is_err() {
        return;
    }
    // Like CineShare, observe release before Tao forwards Command-keyUp straight to NSWindow.
    unsafe {
        let cancel_block = RcBlock::new(move |_| {
            if let Some(app) = APP.get() {
                cancel(app);
            }
        });
        let observer = NSNotificationCenter::defaultCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSApplicationDidResignActiveNotification),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &cancel_block,
            );
        // This single observer, like the application event hook, lives until process exit.
        std::mem::forget(observer);
        let application =
            NSApplication::sharedApplication(MainThreadMarker::new().expect("main thread"));
        let class: &AnyClass = msg_send![&*application, class];
        let method = class
            .instance_method(sel!(sendEvent:))
            .expect("NSApplication.sendEvent");
        let implementation: Imp = std::mem::transmute::<SendEvent, Imp>(send_event);
        let original = method.set_implementation(implementation);
        let _ = ORIGINAL.set(std::mem::transmute::<Imp, SendEvent>(original));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escape_can_cancel_after_the_modifiers_are_released() {
        let now = Instant::now();
        let mut hold = QuitHold::default();
        hold.press(12, now, 2);
        assert!(hold.release(now + Duration::from_secs(2)));
        let ticket = hold.defer();
        assert!(hold.cancel_key(10, 53));
        assert!(!hold.finish(ticket));
        hold.press(12, now, 2);
        assert!(hold.release(now + Duration::from_secs(2)));
        let next = hold.defer();
        assert!(hold.finish(next));
        assert!(!hold.finish(next));
    }
    #[test]
    fn escape_event_cancels_before_quit_key_or_recording_dispatch() {
        let now = Instant::now();
        let mut hold = QuitHold::default();
        assert_eq!(hold.press(53, now, 2), "hold");
        assert!(hold.cancel_key(10, 53));
        assert!(!hold.release(now + Duration::from_secs(2)));
        hold.press(12, now, 1);
        assert!(hold.cancel_key(10, 53));
        assert_eq!(hold.press(12, now, 1), "double");
        assert!(!hold.cancel_key(11, 53));
    }
    #[test]
    fn quit_modes_and_double_press_window() {
        let now = Instant::now();
        let mut hold = QuitHold::default();
        assert_eq!(hold.press(12, now, 0), "quit");
        assert_eq!(hold.press(12, now, 1), "double");
        assert_eq!(
            hold.press(12, now + Duration::from_millis(751), 1),
            "double"
        );
        assert_eq!(hold.press(12, now + Duration::from_millis(1000), 1), "quit");
        assert_eq!(hold.press(12, now + Duration::from_secs(2), 1), "double");
        assert_eq!(hold.press(12, now, 2), "hold");
        assert!(!hold.release(now + Duration::from_millis(500)));
        assert_eq!(hold.press(12, now, 2), "hold");
        assert!(hold.release(now + Duration::from_secs(1)));
    }
    #[test]
    fn quit_requires_a_full_hold_and_release() {
        let now = Instant::now();
        let mut hold = QuitHold {
            pressed: Some((12, now)),
            first_press: None,
            ..Default::default()
        };
        assert!(!hold.release(now + Duration::from_millis(999)));
        hold.pressed = Some((12, now));
        assert!(hold.release(now + Duration::from_secs(1)));
        assert!(!hold.release(now + Duration::from_secs(2)));
        hold.pressed = Some((12, now));
        hold.pressed = None;
        assert!(!hold.release(now + Duration::from_secs(2)));
    }
}

#[cfg(test)]
mod cancellation_tests {
    #[test]
    fn escape_cancels_both_hold_and_double_press() {
        let now = std::time::Instant::now();
        let mut hold = super::QuitHold::default();
        hold.press(12, now, 2);
        hold.cancel();
        assert!(!hold.release(now + std::time::Duration::from_secs(2)));
        hold.press(12, now, 1);
        hold.cancel();
        assert_eq!(hold.press(12, now, 1), "double");
    }
}

#[cfg(test)]
mod held_escape_regression {
    #[test]
    fn escape_cancels_the_entire_hold_until_a_key_is_released() {
        let mut gesture = super::QuitHold::default();
        let now = std::time::Instant::now();
        assert_eq!(gesture.press(12, now, 2), "hold");
        assert!(gesture.cancel_key(10, 53));
        assert_eq!(
            gesture.press(12, now + std::time::Duration::from_secs(2), 2),
            "cancelled"
        );
        assert!(!gesture.release(now + std::time::Duration::from_secs(4)));
        assert!(gesture.suppress_cancelled(10, 12, true));
        assert!(!gesture.suppress_cancelled(11, 12, true));
        assert_eq!(gesture.press(12, now, 2), "hold");
        gesture.cancel_held();
        assert!(!gesture.suppress_cancelled(12, 55, false));
        assert_eq!(gesture.press(12, now, 2), "hold");
        gesture.cancel_held();
        gesture.cancel(); // Losing focus or changing shortcuts resets the latch.
        assert_eq!(gesture.press(12, now, 2), "hold");
    }
}

#[cfg(test)]
mod hardware_escape_tests {
    #[test]
    fn escape_between_the_last_poll_and_release_prevents_quitting() {
        let mut hold = super::QuitHold::default();
        let now = std::time::Instant::now();
        hold.press(12, now, 2);
        assert!(!hold.release_with_escape(now + std::time::Duration::from_secs(2), true));
        assert!(hold.pressed.is_none());
        assert!(hold.pending.is_none());
        assert_eq!(hold.press(12, now, 2), "hold");
        assert!(hold.release_with_escape(now + std::time::Duration::from_secs(2), false));
    }
    #[test]
    fn consumed_escape_still_cancels_the_current_hold_without_an_escape_event() {
        let mut hold = super::QuitHold::default();
        let now = std::time::Instant::now();
        hold.press(53, now, 2);
        assert!(!hold.observe_escape(hold.generation, true));
        assert!(hold.release(now + std::time::Duration::from_secs(2)));
        for elapsed in [300, 1400] {
            hold.cancel();
            hold.press(12, now, 2);
            let generation = hold.generation;
            assert!(!hold.observe_escape(generation.wrapping_sub(1), true));
            assert!(hold.observe_escape(generation, true));
            assert!(!hold.release(now + std::time::Duration::from_millis(elapsed)));
            assert_eq!(hold.press(12, now, 2), "cancelled");
        }
    }
}
