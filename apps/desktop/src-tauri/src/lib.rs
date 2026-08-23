//! The desktop shell: one window, a tray menu, and the three native capabilities
//! the web layer cannot provide for itself (HTTP that is not subject to CORS,
//! a durable key-value store, and OS notifications).

mod idle;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const MAIN_WINDOW: &str = "main";

#[tauri::command]
fn idle_seconds() -> f64 {
    idle::seconds()
}

/// Brings the existing window back rather than opening another one.
fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

    let show = MenuItem::with_id(app, "show", "Show to-hoot", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("tray")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("to-hoot")
        .menu(&menu)
        // Deliberately no `on_tray_icon_event`. Linux delivers no click events
        // for a tray icon, so a click handler would be a feature that exists on
        // some machines and not others; everything reachable from the tray is
        // reachable from the menu.
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => focus_main(app),
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                // The checkmark follows what the OS accepted, not what was
                // clicked, so a refused write does not leave a lying menu.
                if result.is_ok() {
                    let _ = autostart.set_checked(!enabled);
                } else {
                    let _ = autostart.set_checked(enabled);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // Single instance is registered first, and must stay first: registered
        // after another plugin it stops deduplicating, silently, and a second
        // launch opens a second copy writing to the same event log.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![idle_seconds])
        .setup(|app| {
            build_tray(app.handle())?;
            Ok(())
        })
        // Closing the window hides it. A timer that stops because a window was
        // closed would lose the stretch it was measuring; the tray menu is how
        // the app is actually quit.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start the to-hoot desktop shell");
}
