#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod telemetry;

use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent, Wry,
};
use tauri_plugin_window_state::StateFlags;

/// Single source of truth for window behaviour; the UI renders whatever `prefs` emits.
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    /// Docked = tray popup: not always-on-top, hides on blur, opens beside the tray icon.
    docked: bool,
    /// Locked = dragging disabled (enforced by the UI's drag handler).
    locked: bool,
    /// Ghost = mouse events pass through the window. Only the tray menu can undo it.
    click_through: bool,
}

const PREF_KEYS: [&str; 3] = ["docked", "locked", "click_through"];

struct AppState {
    prefs: Mutex<Prefs>,
    checks: [CheckMenuItem<Wry>; 3],
    blur_hidden_at: Mutex<Option<Instant>>,
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main").ok_or_else(|| "main window missing".into())
}

/// Set (or toggle when `on` is None) a pref, apply it natively, sync the tray, notify the UI.
fn apply_pref(app: &AppHandle, key: &str, on: Option<bool>) -> Result<Prefs, String> {
    let idx = PREF_KEYS.iter().position(|k| *k == key).ok_or(format!("unknown pref {key}"))?;
    let st = app.state::<AppState>();
    // Mutate under the lock, then drop it before touching window/menu APIs
    // (they hop to the main thread, which may itself want this lock).
    let (v, snap) = {
        let mut p = st.prefs.lock().unwrap();
        let slot = match idx {
            0 => &mut p.docked,
            1 => &mut p.locked,
            _ => &mut p.click_through,
        };
        *slot = on.unwrap_or(!*slot);
        (*slot, *p)
    };
    let win = main_window(app)?;
    let e = |e: tauri::Error| e.to_string();
    st.checks[idx].set_checked(v).map_err(e)?;
    match idx {
        0 => win.set_always_on_top(!v).map_err(e)?,
        2 => win.set_ignore_cursor_events(v).map_err(e)?,
        _ => {}
    }
    app.emit("prefs", snap).map_err(e)?;
    Ok(snap)
}

/// Position the popup next to the tray icon, on whichever monitor was clicked,
/// above the icon for bottom taskbars and below it for top menu bars.
fn place_near_tray(win: &WebviewWindow, click: PhysicalPosition<f64>) {
    let (Ok(size), Some(mon)) = (
        win.outer_size(),
        win.monitor_from_point(click.x, click.y).ok().flatten().or(win.current_monitor().ok().flatten()),
    ) else {
        return;
    };
    let (mp, ms) = (mon.position(), mon.size());
    let (w, h) = (size.width as f64, size.height as f64);
    let (left, top) = (mp.x as f64, mp.y as f64);
    let (right, bottom) = (left + ms.width as f64, top + ms.height as f64);
    let y = if click.y < top + ms.height as f64 / 2.0 { click.y + 12.0 } else { click.y - h - 12.0 };
    let x = (click.x - w / 2.0).clamp(left + 8.0, (right - w - 8.0).max(left));
    let y = y.clamp(top + 8.0, (bottom - h - 8.0).max(top));
    let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
}

fn toggle_window(app: &AppHandle, click: Option<PhysicalPosition<f64>>) {
    let Ok(win) = main_window(app) else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    let st = app.state::<AppState>();
    // Clicking the tray blurs the popup first; don't instantly re-open what the blur just closed.
    if st.blur_hidden_at.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(300)) {
        return;
    }
    let docked = st.prefs.lock().unwrap().docked;
    if let (true, Some(p)) = (docked, click) {
        place_near_tray(&win, p);
    }
    let _ = win.show();
    let _ = win.set_focus();
}

/// Rescue for a widget lost on a disconnected monitor.
fn move_to_primary(app: &AppHandle) {
    let Ok(win) = main_window(app) else { return };
    if let (Ok(Some(m)), Ok(size)) = (win.primary_monitor(), win.outer_size()) {
        let (p, s) = (m.position(), m.size());
        let x = p.x + (s.width as i32 - size.width as i32) / 2;
        let y = p.y + (s.height as i32 - size.height as i32) / 2;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    let _ = win.show();
}

/// The notch island: a click-through pill window pinned top-centre of the primary screen.
/// Called at startup and again right before every pop-up, because a display change or another
/// app going full-screen can leave it stale. On macOS it is raised above the menu bar and joins
/// every Space, including other apps' full-screen Spaces.
fn pin_island(win: &WebviewWindow) {
    let _ = win.set_ignore_cursor_events(true); // purely visual; never steals clicks
    if let (Ok(Some(m)), Ok(size)) = (win.primary_monitor(), win.outer_size()) {
        let (p, s) = (m.position(), m.size());
        let _ = win.set_position(PhysicalPosition::new(p.x + (s.width as i32 - size.width as i32) / 2, p.y));
    }
    #[cfg(target_os = "macos")]
    if let Ok(ns) = win.ns_window() {
        use objc2::{msg_send, runtime::AnyObject};
        const STATUS_LEVEL_PLUS_ONE: isize = 26; // NSStatusWindowLevel (25) + 1: above the menu bar
        const BEHAVIOR: usize = 1 | 16 | 64 | 256; // all Spaces | stationary | ignores cycle | full-screen auxiliary
        let ns = ns as usize;
        // AppKit must be touched on the main thread; the command may arrive on another one.
        let _ = win.run_on_main_thread(move || {
            // SAFETY: on the main thread; `ns` is this window's live NSWindow (the window outlives this call).
            unsafe {
                let ns = ns as *mut AnyObject;
                let _: () = msg_send![ns, setLevel: STATUS_LEVEL_PLUS_ONE];
                let _: () = msg_send![ns, setCollectionBehavior: BEHAVIOR];
                // Re-order so the window joins the *current* Space (incl. another app's full-screen one).
                let nil: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![ns, orderOut: nil];
                let _: () = msg_send![ns, orderFrontRegardless]; // front without activating the app
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_always_on_top(true); // re-assert: borderless full-screen apps can steal topmost
}

/// macOS only lets a *non-activating panel* float over another app's full-screen Space;
/// a plain NSWindow is hidden there no matter its level or collection flags. Convert once at startup,
/// while the window has never been shown (it is created `visible: false`) — converting a window that
/// was already ordered in leaves it stuck off the full-screen Space (`isOnActiveSpace` stays false).
#[cfg(target_os = "macos")]
fn make_island_panel(win: &WebviewWindow) {
    use objc2::{ffi::object_setClass, msg_send, runtime::{AnyClass, AnyObject}};
    let (Ok(ns), Some(panel)) = (win.ns_window(), AnyClass::get(c"NSPanel")) else { return };
    const NONACTIVATING_PANEL: usize = 1 << 7;
    // SAFETY: called from setup on the main thread; NSPanel is an NSWindow subclass adding no ivars,
    // so re-classing the live window is layout-compatible (the approach tauri-nspanel takes).
    unsafe {
        let ns = ns as *mut AnyObject;
        object_setClass(ns, panel);
        let mask: usize = msg_send![ns, styleMask];
        let _: () = msg_send![ns, setStyleMask: mask | NONACTIVATING_PANEL];
        let _: () = msg_send![ns, setHidesOnDeactivate: false]; // panels hide when the app is inactive by default
        let _: () = msg_send![ns, setBecomesKeyOnlyIfNeeded: true];
    }
}

#[tauri::command]
fn island_front(window: WebviewWindow) {
    pin_island(&window);
}

#[derive(Serialize)]
struct Notch {
    width: f64,
    height: f64,
}

/// Size of the camera housing on the primary (menu-bar) screen, in points; zero when there is none.
/// The island keeps every pixel of content out of this rectangle.
#[tauri::command]
fn notch() -> Notch {
    #[cfg(target_os = "macos")]
    // SAFETY: sync commands run on the main thread; plain NSScreen property reads.
    unsafe {
        use objc2::{msg_send, runtime::{AnyClass, AnyObject}, sel};
        use objc2_foundation::NSRect;
        if let Some(cls) = AnyClass::get(c"NSScreen") {
            let screens: *mut AnyObject = msg_send![cls, screens];
            let screen: *mut AnyObject = msg_send![screens, firstObject];
            let has_aux: bool = !screen.is_null() && msg_send![screen, respondsToSelector: sel!(auxiliaryTopLeftArea)];
            if has_aux {
                let frame: NSRect = msg_send![screen, frame];
                let (l, r): (NSRect, NSRect) = (msg_send![screen, auxiliaryTopLeftArea], msg_send![screen, auxiliaryTopRightArea]);
                if l.size.width > 0.0 && r.size.width > 0.0 {
                    return Notch { width: frame.size.width - l.size.width - r.size.width, height: l.size.height };
                }
            }
        }
    }
    Notch { width: 0.0, height: 0.0 }
}

/// The island has no devtools of its own in release; its errors and milestones land in stderr.
#[tauri::command]
fn island_log(msg: String) {
    eprintln!("[island] {msg}");
}

/// Menu-bar glyph: the bot's screen outline and two eyes, drawn as an anti-aliased template
/// image (black + alpha; macOS tints it for light/dark menu bars). 44 px = 22 pt @2x.
#[cfg(target_os = "macos")]
fn tray_glyph() -> tauri::image::Image<'static> {
    const S: u32 = 44;
    // signed distance to a rounded box centred at (cx, cy), half-size (hx, hy), corner radius r
    let sd = |x: f32, y: f32, cx: f32, cy: f32, hx: f32, hy: f32, r: f32| {
        let (qx, qy) = ((x - cx).abs() - hx + r, (y - cy).abs() - hy + r);
        qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r
    };
    let mut px = vec![0u8; (S * S * 4) as usize];
    for y in 0..S {
        for x in 0..S {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let ring = 1.75 - sd(fx, fy, 22.0, 22.5, 16.0, 13.0, 9.0).abs(); // 3.5 px outline
            let eyes = -sd(fx, fy, 16.5, 22.5, 2.5, 4.5, 2.5).min(sd(fx, fy, 27.5, 22.5, 2.5, 4.5, 2.5));
            px[((y * S + x) * 4 + 3) as usize] = ((ring.max(eyes) + 0.5).clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
    tauri::image::Image::new_owned(px, S, S)
}

#[tauri::command]
fn set_pref(app: AppHandle, key: String, on: bool) -> Result<Prefs, String> {
    apply_pref(&app, &key, Some(on))
}

#[tauri::command]
fn kill_process(pid: u32, sys: State<telemetry::SharedSys>) -> Result<(), String> {
    if pid == std::process::id() {
        return Err("Nice try. I'm not killing myself.".into());
    }
    let sys = sys.lock().unwrap_or_else(|e| e.into_inner());
    let proc = sys.process(sysinfo::Pid::from_u32(pid)).ok_or("process already gone")?;
    if proc.kill() {
        Ok(())
    } else {
        Err("OS refused (needs elevated rights?)".into())
    }
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            // Remembers position across launches and won't restore onto a missing monitor.
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .with_denylist(&["island"]) // island is always re-pinned to the notch
                .build(),
        )
        .invoke_handler(tauri::generate_handler![set_pref, kill_process, reveal_path, island_front, island_log, notch])
        .setup(|app| {
            // Widget, not an app: no Dock icon on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let h = app.handle();
            let checks = [
                CheckMenuItem::with_id(h, "docked", "Docked tray popup", true, false, None::<&str>)?,
                CheckMenuItem::with_id(h, "locked", "Lock position", true, false, None::<&str>)?,
                CheckMenuItem::with_id(h, "click_through", "Click-through (ghost)", true, false, None::<&str>)?,
            ];
            let toggle = MenuItem::with_id(h, "toggle", "Show / Hide", true, None::<&str>)?;
            let primary = MenuItem::with_id(h, "primary", "Move to primary screen", true, None::<&str>)?;
            let test_island = MenuItem::with_id(h, "test_island", "Test the notch island", true, None::<&str>)?;
            let quit = MenuItem::with_id(h, "quit", "Quit Puco", true, None::<&str>)?;
            let (s1, s2) = (PredefinedMenuItem::separator(h)?, PredefinedMenuItem::separator(h)?);
            let menu = Menu::with_items(
                h,
                &[&toggle, &s1, &checks[0], &checks[1], &checks[2], &s2, &primary, &test_island, &quit],
            )?;

            app.manage(AppState { prefs: Mutex::new(Prefs::default()), checks, blur_hidden_at: Mutex::new(None) });
            app.manage(telemetry::spawn(h.clone()));
            if let Some(island) = h.get_webview_window("island") {
                #[cfg(target_os = "macos")]
                make_island_panel(&island);
                pin_island(&island);
            }

            #[cfg(target_os = "macos")]
            let tray_icon = tray_glyph();
            #[cfg(not(target_os = "macos"))]
            let tray_icon = app.default_window_icon().cloned().ok_or("missing app icon")?; // stays visible on any taskbar theme
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Puco")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "toggle" => toggle_window(app, None),
                    "primary" => move_to_primary(app),
                    "test_island" => {
                        let _ = app.emit_to("island", "island-test", ());
                    }
                    "quit" => app.exit(0),
                    key => {
                        let _ = apply_pref(app, key, None);
                    }
                })
                .on_tray_icon_event(|tray, ev| {
                    // Note: Linux trays don't emit click events; the menu's Show / Hide covers it.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = ev
                    {
                        toggle_window(tray.app_handle(), Some(position));
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|w, ev| {
            if let (WindowEvent::Focused(false), "main") = (ev, w.label()) {
                let Some(st) = w.try_state::<AppState>() else { return };
                if st.prefs.lock().unwrap().docked {
                    *st.blur_hidden_at.lock().unwrap() = Some(Instant::now());
                    let _ = w.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Puco");
}
