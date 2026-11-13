use serde::Deserialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HitRegion {
    Circle {
        cx: f64,
        cy: f64,
        r: f64,
    },
    RoundRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        r: f64,
    },
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    },
}

impl HitRegion {
    fn contains(&self, lx: f64, ly: f64) -> bool {
        match self {
            HitRegion::Circle { cx, cy, r } => {
                let dx = lx - cx;
                let dy = ly - cy;
                dx * dx + dy * dy <= r * r
            }
            HitRegion::RoundRect { x, y, w, h, r } => {
                if lx < *x || lx > *x + *w || ly < *y || ly > *y + *h {
                    return false;
                }
                let radius = r.min(w * 0.5).min(h * 0.5).max(0.0);
                if radius <= 0.0 {
                    return true;
                }
                let inner_left = *x + radius;
                let inner_right = *x + *w - radius;
                let inner_top = *y + radius;
                let inner_bottom = *y + *h - radius;

                let dx = if lx < inner_left {
                    inner_left - lx
                } else if lx > inner_right {
                    lx - inner_right
                } else {
                    0.0
                };
                let dy = if ly < inner_top {
                    inner_top - ly
                } else if ly > inner_bottom {
                    ly - inner_bottom
                } else {
                    0.0
                };
                dx * dx + dy * dy <= radius * radius
            }
            HitRegion::Rect { x, y, w, h } => lx >= *x && lx <= *x + *w && ly >= *y && ly <= *y + *h,
        }
    }
}

#[derive(Clone, PartialEq, Deserialize)]
pub struct HitConfig {
    pub capture_all: bool,
    pub regions: Vec<HitRegion>,
}

impl Default for HitConfig {
    fn default() -> Self {
        // Default initial circle matches the compact 62px orb at (14, 18)
        Self {
            capture_all: false,
            regions: vec![HitRegion::Circle {
                cx: 45.0,
                cy: 49.0,
                r: 31.0,
            }],
        }
    }
}

struct HitInternal {
    config: HitConfig,
    ignoring: Option<bool>,
    seq: u64,
}

struct OverlayInner {
    hit: Mutex<HitInternal>,
    wakeup: Condvar,
    scale_milli: AtomicU32,
    want_ignore: AtomicBool,
    topmost_dirty: AtomicBool,
    dispatch_queued: AtomicBool,
}

pub struct OverlayState(Arc<OverlayInner>);

impl OverlayState {
    pub fn new() -> Self {
        Self(Arc::new(OverlayInner {
            hit: Mutex::new(HitInternal {
                config: HitConfig::default(),
                ignoring: None,
                seq: 0,
            }),
            wakeup: Condvar::new(),
            scale_milli: AtomicU32::new(1000),
            want_ignore: AtomicBool::new(true),
            topmost_dirty: AtomicBool::new(false),
            dispatch_queued: AtomicBool::new(false),
        }))
    }

    pub fn set_scale_factor(&self, scale: f64) {
        let milli = (scale.max(1.0) * 1000.0).round() as u32;
        self.0.scale_milli.store(milli, Ordering::Relaxed);
        self.0.wakeup.notify_one();
    }

    pub fn mark_topmost_dirty(&self) {
        self.0.topmost_dirty.store(true, Ordering::Release);
        self.0.wakeup.notify_one();
    }
}

#[cfg(windows)]
fn exstyle_needs_repair(window: &WebviewWindow) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, WS_EX_LAYERED,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };

    let Ok(raw_hwnd) = window.hwnd() else {
        return false;
    };
    let hwnd = HWND(raw_hwnd.0 as _);
    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return false;
        }
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let base_bits = (WS_EX_LAYERED.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) as isize;
        (ex_style & base_bits) != base_bits
            || IsIconic(hwnd).as_bool()
            || !IsWindowVisible(hwnd).as_bool()
    }
}

#[cfg(not(windows))]
fn exstyle_needs_repair(_window: &WebviewWindow) -> bool {
    false
}

fn queue_main_sync(window: &WebviewWindow, shared: &Arc<OverlayInner>) {
    if shared
        .dispatch_queued
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        let win_clone = window.clone();
        let shared_clone = Arc::clone(shared);
        if window
            .app_handle()
            .run_on_main_thread(move || {
                shared_clone.dispatch_queued.store(false, Ordering::Release);
                let want_ignore = shared_clone.want_ignore.load(Ordering::Acquire);
                apply_overlay_exstyle(&win_clone, want_ignore);
                if shared_clone.topmost_dirty.swap(false, Ordering::AcqRel) {
                    pin_window_topmost(&win_clone);
                }
            })
            .is_err()
        {
            shared.dispatch_queued.store(false, Ordering::Release);
        }
    }
}

#[cfg(windows)]
fn apply_overlay_exstyle(window: &WebviewWindow, want_ignore: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, IsWindow, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
    };

    let Ok(raw_hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(raw_hwnd.0 as _);

    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return;
        }
        let base_bits = (WS_EX_LAYERED.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) as isize;
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let transparent_bit = WS_EX_TRANSPARENT.0 as isize;
        let target = if want_ignore {
            current | base_bits | transparent_bit
        } else {
            (current | base_bits) & !transparent_bit
        };

        // Keep WS_EX_LAYERED constant and omit SWP_FRAMECHANGED to prevent DWM surface reallocation
        if target != current {
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, target);
        }
    }
}

#[cfg(not(windows))]
fn apply_overlay_exstyle(window: &WebviewWindow, want_ignore: bool) {
    let _ = window.set_ignore_cursor_events(want_ignore);
}

pub fn init_overlay(window: &WebviewWindow, state: &OverlayState) {
    if let Ok(scale) = window.scale_factor() {
        state.set_scale_factor(scale);
    }
    apply_overlay_exstyle(window, true);
    pin_window_topmost(window);
}

#[cfg(windows)]
pub fn pin_window_topmost(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, IsIconic, IsWindow, IsWindowVisible, SetWindowLongPtrW, SetWindowPos,
        ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST,
    };

    let Ok(raw_hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(raw_hwnd.0 as _);

    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return;
        }
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let target_bits = (WS_EX_LAYERED.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) as isize;
        if (ex_style & target_bits) != target_bits {
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | target_bits);
        }

        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }

        let mut flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
        if !IsWindowVisible(hwnd).as_bool() {
            flags |= SWP_SHOWWINDOW;
        }

        let _ = SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
    }
}

#[cfg(not(windows))]
pub fn pin_window_topmost(window: &WebviewWindow) {
    let _ = window.set_always_on_top(true);
}

enum EvalOutcome {
    Near,
    Far,
    CaptureAll,
    WindowDestroyed,
}

#[cfg(windows)]
fn evaluate_cursor(window: &WebviewWindow, shared: &Arc<OverlayInner>) -> (EvalOutcome, u64) {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect, IsWindow};

    let Ok(raw_hwnd) = window.hwnd() else {
        return (EvalOutcome::WindowDestroyed, 0);
    };
    let hwnd = HWND(raw_hwnd.0 as _);

    let is_alive = unsafe { IsWindow(hwnd).as_bool() };
    if !is_alive {
        return (EvalOutcome::WindowDestroyed, 0);
    }

    let mut pt = POINT::default();
    let mut win_rect = RECT::default();
    let has_coords =
        unsafe { GetCursorPos(&mut pt).is_ok() && GetWindowRect(hwnd, &mut win_rect).is_ok() };
    let scale = (shared.scale_milli.load(Ordering::Relaxed) as f64 / 1000.0).max(1.0);

    let (capture_all, want_ignore, near, changed, emit_leave, seen_seq) = {
        let mut guard = shared.hit.lock().unwrap_or_else(|p| p.into_inner());
        let seen_seq = guard.seq;

        if guard.config.capture_all {
            let changed = guard.ignoring != Some(false);
            guard.ignoring = Some(false);
            (true, false, true, changed, false, seen_seq)
        } else if !has_coords {
            if guard.ignoring.is_none() {
                guard.ignoring = Some(true);
                (false, true, false, true, false, seen_seq)
            } else {
                return (EvalOutcome::Far, seen_seq);
            }
        } else {
            let lx = (pt.x - win_rect.left) as f64 / scale;
            let ly = (pt.y - win_rect.top) as f64 / scale;

            let approach_pad = (90.0 * scale).round() as i32;
            let near = pt.x >= win_rect.left - approach_pad
                && pt.x <= win_rect.right + approach_pad
                && pt.y >= win_rect.top - approach_pad
                && pt.y <= win_rect.bottom + approach_pad;

            let inside = near && guard.config.regions.iter().any(|r| r.contains(lx, ly));
            let want_ignore = !inside;
            let prev = guard.ignoring;
            let changed = prev != Some(want_ignore);
            guard.ignoring = Some(want_ignore);
            (
                false,
                want_ignore,
                near,
                changed,
                want_ignore && prev == Some(false),
                seen_seq,
            )
        }
    };

    if changed {
        shared.want_ignore.store(want_ignore, Ordering::Release);
        queue_main_sync(window, shared);
        if emit_leave {
            let _ = window.emit("overlay-cursor-leave", ());
        }
    }

    let outcome = if capture_all {
        EvalOutcome::CaptureAll
    } else if near {
        EvalOutcome::Near
    } else {
        EvalOutcome::Far
    };
    (outcome, seen_seq)
}

#[cfg(not(windows))]
fn evaluate_cursor(_window: &WebviewWindow, shared: &Arc<OverlayInner>) -> (EvalOutcome, u64) {
    let seq = shared.hit.lock().map(|g| g.seq).unwrap_or(0);
    (EvalOutcome::Far, seq)
}

pub fn spawn_overlay_controller(window: WebviewWindow, state: &OverlayState) {
    let shared = Arc::clone(&state.0);
    std::thread::Builder::new()
        .name("audiocycle-overlay-guard".into())
        .spawn(move || {
            // Supervisor: if the guard loop ever panics, restart it instead of
            // leaving the overlay stuck in a click-blocking or hidden state.
            for _attempt in 0..20 {
                let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    overlay_guard_loop(&window, &shared)
                }));
                if run.is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        })
        .ok();
}

fn overlay_guard_loop(window: &WebviewWindow, shared: &Arc<OverlayInner>) {
    let mut last_topmost = Instant::now();
    loop {
        let (outcome, seen_seq) = evaluate_cursor(window, shared);
        if matches!(outcome, EvalOutcome::WindowDestroyed) {
            break;
        }

        if shared.topmost_dirty.load(Ordering::Acquire)
            || (last_topmost.elapsed() >= Duration::from_millis(2500)
                && exstyle_needs_repair(window))
        {
            shared.topmost_dirty.store(true, Ordering::Release);
            queue_main_sync(window, shared);
            last_topmost = Instant::now();
        } else if last_topmost.elapsed() >= Duration::from_millis(2500) {
            last_topmost = Instant::now();
        }

        let sleep_ms = match outcome {
            EvalOutcome::CaptureAll => 120,
            EvalOutcome::Near => 8,
            EvalOutcome::Far => 35,
            EvalOutcome::WindowDestroyed => break,
        };

        let guard = shared.hit.lock().unwrap_or_else(|p| p.into_inner());
        let _ = shared.wakeup.wait_timeout_while(
            guard,
            Duration::from_millis(sleep_ms),
            |g| g.seq == seen_seq && !shared.topmost_dirty.load(Ordering::Acquire),
        );
    }
}

#[tauri::command]
pub fn set_hit_regions(
    _app: AppHandle,
    state: tauri::State<'_, OverlayState>,
    config: HitConfig,
) -> Result<(), String> {
    let changed = {
        let mut guard = state.0.hit.lock().unwrap_or_else(|p| p.into_inner());
        if guard.config == config {
            false
        } else {
            guard.config = config;
            guard.seq = guard.seq.wrapping_add(1);
            true
        }
    };
    if changed {
        state.0.wakeup.notify_one();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::HitRegion;

    #[test]
    fn circle_excludes_bounding_box_corners() {
        let pod = HitRegion::Circle {
            cx: 45.0,
            cy: 49.0,
            r: 31.0,
        };
        assert!(pod.contains(45.0, 49.0));
        assert!(pod.contains(76.0, 49.0));
        // Bounding box corner at (14, 18) is distance ~43.84 > 31, must pass through
        assert!(!pod.contains(14.0, 18.0));
        assert!(!pod.contains(74.0, 20.0));
    }

    #[test]
    fn roundrect_excludes_cut_corners_and_accepts_inner_edges() {
        let rr = HitRegion::RoundRect {
            x: 10.0,
            y: 20.0,
            w: 60.0,
            h: 60.0,
            r: 15.0,
        };
        assert!(rr.contains(40.0, 20.0));
        assert!(rr.contains(10.0, 50.0));
        assert!(!rr.contains(11.0, 21.0));
        assert!(!rr.contains(69.0, 79.0));
    }

    #[test]
    fn rect_matches_exact_bounds() {
        let r = HitRegion::Rect {
            x: 10.0,
            y: 20.0,
            w: 30.0,
            h: 40.0,
        };
        assert!(r.contains(10.0, 20.0));
        assert!(r.contains(40.0, 60.0));
        assert!(!r.contains(9.9, 20.0));
        assert!(!r.contains(40.1, 60.0));
    }
}
