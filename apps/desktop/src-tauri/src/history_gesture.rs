use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase, NSWindow};
use std::{cell::RefCell, ptr::NonNull};
use tauri::{Emitter, WebviewWindow};

struct Monitor(Retained<AnyObject>);

impl Drop for Monitor {
    fn drop(&mut self) {
        unsafe { NSEvent::removeMonitor(&self.0) };
    }
}

thread_local! {
    static MONITOR: RefCell<Option<Monitor>> = const { RefCell::new(None) };
}

fn boundary(phase: NSEventPhase, momentum: NSEventPhase) -> Option<&'static str> {
    if phase.contains(NSEventPhase::Cancelled) {
        Some("cancel")
    } else if phase.contains(NSEventPhase::Ended) {
        Some("end")
    } else if phase.contains(NSEventPhase::Began) {
        Some("begin")
    } else if momentum.intersects(NSEventPhase::Ended | NSEventPhase::Cancelled) {
        Some("momentum-end")
    } else if momentum.contains(NSEventPhase::Began) {
        Some("momentum")
    } else {
        None
    }
}

pub fn setup(window: &WebviewWindow) -> tauri::Result<()> {
    let pointer = window.ns_window()?;
    let number = unsafe { &*pointer.cast::<NSWindow>() }.windowNumber();
    let window = window.clone();
    let handler = RcBlock::new(move |pointer: NonNull<NSEvent>| {
        // DOM wheel events lack finger-release and momentum boundaries.
        let event = unsafe { pointer.as_ref() };
        if event.windowNumber() == number {
            if let Some(phase) = boundary(event.phase(), event.momentumPhase()) {
                let _ = window.emit_to(window.label(), "trawl:history-gesture-phase", phase);
            }
        }
        pointer.as_ptr()
    });
    // Keep WebKit's wheel delivery intact; the renderer owns scroll-surface selection.
    let token = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &handler)
    };
    if token.is_none() {
        eprintln!("Trackpad gesture phase monitor is unavailable");
    }
    MONITOR.with(|monitor| *monitor.borrow_mut() = token.map(Monitor));
    Ok(())
}

pub fn shutdown() {
    MONITOR.with(|monitor| monitor.borrow_mut().take());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_finger_release_from_momentum_and_ignores_regular_wheels() {
        let none = NSEventPhase::None;
        assert_eq!(boundary(none, none), None);
        assert_eq!(boundary(NSEventPhase::Changed, none), None);
        assert_eq!(boundary(NSEventPhase::Began, none), Some("begin"));
        assert_eq!(boundary(NSEventPhase::Cancelled, none), Some("cancel"));
        assert_eq!(
            boundary(NSEventPhase::Ended, NSEventPhase::Began),
            Some("end")
        );
        assert_eq!(boundary(none, NSEventPhase::Began), Some("momentum"));
        assert_eq!(boundary(none, NSEventPhase::Ended), Some("momentum-end"));
    }
}
