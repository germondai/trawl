use block2::RcBlock;
use objc2::{
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
    MainThreadMarker,
};
use objc2_app_kit::{
    NSApplicationDidChangeScreenParametersNotification, NSScreen, NSWindow,
    NSWindowDidChangeScreenNotification, NSWindowDidExitFullScreenNotification,
    NSWindowDidResizeNotification, NSWindowDidUpdateNotification, NSWindowStyleMask,
};
use objc2_foundation::{
    NSNotificationCenter, NSObjectProtocol, NSOperationQueue, NSPoint, NSRect, NSSize, NSString,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use tauri::{Manager, WebviewWindow};

struct Observation(
    Retained<ProtocolObject<dyn NSObjectProtocol>>,
    Rc<Cell<bool>>,
);

impl Drop for Observation {
    fn drop(&mut self) {
        self.1.set(false);
        unsafe { NSNotificationCenter::defaultCenter().removeObserver((*self.0).as_ref()) };
    }
}

thread_local! {
    static OBSERVATIONS: RefCell<Vec<Observation>> = const { RefCell::new(Vec::new()) };
}

fn overlap(frame: NSRect, area: NSRect) -> f64 {
    let width = (frame.origin.x + frame.size.width).min(area.origin.x + area.size.width)
        - frame.origin.x.max(area.origin.x);
    let height = (frame.origin.y + frame.size.height).min(area.origin.y + area.size.height)
        - frame.origin.y.max(area.origin.y);
    width.max(0.0) * height.max(0.0)
}

fn work_area(frame: NSRect, areas: &[NSRect]) -> Option<NSRect> {
    areas
        .iter()
        .filter(|area| overlap(frame, **area) > 0.0)
        .max_by(|a, b| overlap(frame, **a).total_cmp(&overlap(frame, **b)))
        .or_else(|| areas.first())
        .copied()
}

fn fitted_frame(frame: NSRect, area: NSRect, minimum: NSSize, constrain_frame: bool) -> NSRect {
    if !constrain_frame && frame.size.width >= minimum.width && frame.size.height >= minimum.height
    {
        return frame;
    }
    let size = NSSize::new(
        frame.size.width.max(minimum.width).min(area.size.width),
        frame.size.height.max(minimum.height).min(area.size.height),
    );
    NSRect::new(
        NSPoint::new(
            frame
                .origin
                .x
                .clamp(area.origin.x, area.origin.x + area.size.width - size.width),
            (frame.origin.y + frame.size.height - size.height).clamp(
                area.origin.y,
                area.origin.y + area.size.height - size.height,
            ),
        ),
        size,
    )
}

fn relative_frame(frame: NSRect, from: NSRect, to: NSRect, minimum: NSSize) -> NSRect {
    let width = (frame.size.width / from.size.width * to.size.width)
        .max(minimum.width)
        .min(to.size.width);
    let height = (frame.size.height / from.size.height * to.size.height)
        .max(minimum.height)
        .min(to.size.height);
    let x = ((frame.origin.x - from.origin.x) / (from.size.width - frame.size.width).max(1.0))
        .clamp(0.0, 1.0);
    let y = ((frame.origin.y - from.origin.y) / (from.size.height - frame.size.height).max(1.0))
        .clamp(0.0, 1.0);
    NSRect::new(
        NSPoint::new(
            to.origin.x + x * (to.size.width - width),
            to.origin.y + y * (to.size.height - height),
        ),
        NSSize::new(width, height),
    )
}

fn fit(
    window: &WebviewWindow,
    minimum: NSSize,
    constrain_frame: bool,
    mtm: MainThreadMarker,
) -> tauri::Result<()> {
    let pointer = window.ns_window()?;
    // All callers execute on the AppKit main thread, while the Tauri window exists.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return Ok(());
    }
    let areas: Vec<_> = NSScreen::screens(mtm)
        .iter()
        .map(|screen| screen.visibleFrame())
        .filter(|area| area.size.width > 0.0 && area.size.height > 0.0)
        .collect();
    let frame = native.frame();
    let Some(area) = work_area(frame, &areas) else {
        return Ok(());
    };
    let available = native.contentRectForFrameRect(area).size;
    let effective_minimum = NSSize::new(
        minimum.width.min(available.width),
        minimum.height.min(available.height),
    );
    if native.contentMinSize() != effective_minimum {
        native.setContentMinSize(effective_minimum);
    }
    let minimum_frame = native
        .frameRectForContentRect(NSRect::new(NSPoint::new(0.0, 0.0), effective_minimum))
        .size;
    let next = fitted_frame(frame, area, minimum_frame, constrain_frame);
    if frame != next {
        native.setFrame_display(next, false);
    }
    Ok(())
}

pub fn setup(window: &WebviewWindow) -> tauri::Result<()> {
    shutdown();
    let mtm = MainThreadMarker::new().expect("Window setup runs on the main thread");
    let pointer = window.ns_window()?;
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    let minimum = native.contentMinSize();
    let name = NSString::from_str(&format!(
        "{}.main{}",
        window.app_handle().config().identifier,
        if cfg!(debug_assertions) { ".debug" } else { "" }
    ));
    // Relax the minimum on a small display before AppKit restores the saved frame.
    fit(window, minimum, true, mtm)?;
    native.setFrameUsingName(&name);
    fit(window, minimum, true, mtm)?;
    if !native.setFrameAutosaveName(&name) {
        eprintln!("Cannot enable native window frame autosave");
    }
    let previous = Rc::new(Cell::new(
        native
            .screen()
            .map(|screen| (native.frame(), screen.visibleFrame())),
    ));

    let active = Rc::new(Cell::new(true));
    let center = NSNotificationCenter::defaultCenter();
    let queue = NSOperationQueue::mainQueue();
    let object: &AnyObject = native;
    unsafe {
        for (notification, object, constrain_frame) in [
            (
                NSApplicationDidChangeScreenParametersNotification,
                None,
                true,
            ),
            (NSWindowDidExitFullScreenNotification, Some(object), true),
            (NSWindowDidChangeScreenNotification, Some(object), false),
        ] {
            let window = window.clone();
            let active = active.clone();
            let callback_active = active.clone();
            let previous = previous.clone();
            let block = RcBlock::new(move |_| {
                if !callback_active.get() {
                    return;
                }
                if let Some(mtm) = MainThreadMarker::new() {
                    if let Ok(pointer) = window.ns_window() {
                        let native = &*pointer.cast::<NSWindow>();
                        if !native.styleMask().contains(NSWindowStyleMask::FullScreen) {
                            if let (Some((frame, area)), Some(screen)) =
                                (previous.get(), native.screen())
                            {
                                let target = screen.visibleFrame();
                                if area != target && area.size.width > 0.0 && area.size.height > 0.0
                                {
                                    let minimum_frame = native
                                        .frameRectForContentRect(NSRect::new(
                                            NSPoint::new(0.0, 0.0),
                                            minimum,
                                        ))
                                        .size;
                                    native.setFrame_display(
                                        relative_frame(frame, area, target, minimum_frame),
                                        true,
                                    );
                                }
                            }
                        }
                    }
                    if let Err(error) = fit(&window, minimum, constrain_frame, mtm) {
                        eprintln!("Cannot fit native window to display: {error}");
                    }
                    let _ = crate::window_chrome::update(&window);
                    if let Ok(pointer) = window.ns_window() {
                        let native = &*pointer.cast::<NSWindow>();
                        previous.set(
                            native
                                .screen()
                                .map(|screen| (native.frame(), screen.visibleFrame())),
                        );
                    }
                }
            });
            let token = center.addObserverForName_object_queue_usingBlock(
                Some(notification),
                object,
                Some(&queue),
                &block,
            );
            OBSERVATIONS
                .with(|observations| observations.borrow_mut().push(Observation(token, active)));
        }
        // Apply after AppKit finishes a layout, never inside individual button mutations.
        for notification in [NSWindowDidResizeNotification, NSWindowDidUpdateNotification] {
            let window = window.clone();
            let active = active.clone();
            let callback_active = active.clone();
            let previous = previous.clone();
            let block = RcBlock::new(move |_| {
                if callback_active.get() {
                    let _ = crate::window_chrome::update(&window);
                    if let Ok(pointer) = window.ns_window() {
                        let native = &*pointer.cast::<NSWindow>();
                        if !native.styleMask().contains(NSWindowStyleMask::FullScreen) {
                            if let Some(screen) = native.screen() {
                                let area = screen.visibleFrame();
                                if previous.get().is_none_or(|(_, old)| old == area) {
                                    previous.set(Some((native.frame(), area)));
                                }
                            }
                        }
                    }
                }
            });
            let token = center.addObserverForName_object_queue_usingBlock(
                Some(notification),
                Some(object),
                None,
                &block,
            );
            OBSERVATIONS
                .with(|observations| observations.borrow_mut().push(Observation(token, active)));
        }
    }
    Ok(())
}

pub fn shutdown() {
    OBSERVATIONS.with(|observations| observations.borrow_mut().clear());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
    }
    #[test]
    fn preserves_window_fraction_when_moving_between_displays() {
        let large = rect(0.0, 0.0, 4000.0, 2000.0);
        let small = rect(-2000.0, 24.0, 2000.0, 1000.0);
        let original = rect(400.0, 200.0, 3200.0, 1600.0);
        let minimum = NSSize::new(480.0, 540.0);
        let resized = relative_frame(original, large, small, minimum);
        assert_eq!(resized, rect(-1800.0, 124.0, 1600.0, 800.0));
        assert_eq!(relative_frame(resized, small, large, minimum), original);
    }

    #[test]
    fn restores_frames_inside_the_available_work_area() {
        let minimum = NSSize::new(480.0, 540.0);
        let hd = rect(0.0, 24.0, 1920.0, 1016.0);
        let valid = rect(100.0, 100.0, 900.0, 600.0);
        assert_eq!(fitted_frame(valid, hd, minimum, true), valid);
        assert_eq!(
            fitted_frame(rect(1500.0, 400.0, 3200.0, 1800.0), hd, minimum, true),
            hd
        );
        assert_eq!(
            fitted_frame(
                rect(-2000.0, -50.0, 900.0, 600.0),
                rect(-1920.0, 0.0, 1920.0, 1080.0),
                minimum,
                true
            ),
            rect(-1920.0, 0.0, 900.0, 600.0)
        );
        let small = rect(0.0, 0.0, 400.0, 300.0);
        assert_eq!(fitted_frame(valid, small, minimum, true), small);
        assert_eq!(fitted_frame(small, hd, minimum, true).size, minimum);
    }

    #[test]
    fn restores_the_minimum_on_a_larger_display_without_repositioning_valid_drags() {
        let minimum = NSSize::new(480.0, 540.0);
        let area = rect(0.0, 24.0, 1920.0, 1016.0);
        let straddling = rect(-100.0, 100.0, 900.0, 600.0);
        assert_eq!(fitted_frame(straddling, area, minimum, false), straddling);
        assert_eq!(
            fitted_frame(rect(100.0, 400.0, 400.0, 300.0), area, minimum, false),
            rect(100.0, 160.0, 480.0, 540.0)
        );
    }

    #[test]
    fn selects_the_largest_overlap_or_falls_back_after_monitor_removal() {
        let primary = rect(0.0, 24.0, 1920.0, 1016.0);
        let secondary = rect(-1920.0, 0.0, 1920.0, 1080.0);
        let frame = rect(-1200.0, 100.0, 1400.0, 800.0);
        assert_eq!(work_area(frame, &[primary, secondary]), Some(secondary));
        assert_eq!(work_area(frame, &[primary]), Some(primary));
        assert_eq!(work_area(frame, &[]), None);
    }
}
