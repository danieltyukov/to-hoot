//! The desktop shell: one window, a tray menu, and the three native capabilities
//! the web layer cannot provide for itself (HTTP that is not subject to CORS,
//! a durable key-value store, and OS notifications).

mod agents;
mod idle;
mod oauth;

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

    let show = MenuItem::with_id(app, "show", "Show ToHoot", true, None::<&str>)?;
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
        .icon(tray_icon(app))
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("ToHoot")
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

/// The menu bar on macOS draws template images: black and clear, tinted by the
/// system to match the bar, the way every other icon up there is drawn. A
/// colour icon would be the one thing in the bar that ignores dark mode. The
/// Linux and Windows trays show the app icon as it is.
///
/// Decoded at compile time, so the shell carries no PNG decoder for one icon.
#[cfg(target_os = "macos")]
fn tray_icon(_app: &AppHandle) -> tauri::image::Image<'static> {
    tauri::include_image!("icons/tray-template.png")
}

#[cfg(not(target_os = "macos"))]
fn tray_icon(app: &AppHandle) -> tauri::image::Image<'static> {
    app.default_window_icon().cloned().expect("bundled icon").to_owned()
}

/// Sets the environment WebKitGTK needs before anything creates a webview.
///
/// The packaged `.desktop` file carries `__NV_DISABLE_EXPLICIT_SYNC=1`, but that
/// only covers launches that go through it. `tauri-plugin-autostart` writes its
/// own autostart entry as a bare path to the executable with no environment, so
/// on NVIDIA the app would come up blank white from the moment the user enabled
/// "Start at login", and only then. Setting it here covers the autostart entry,
/// a terminal launch, and anyone running the binary directly.
///
/// An explicit value in the environment is left alone: someone who set it to 0
/// on purpose, to see the failure or because a driver update fixed it, means it.
#[cfg(target_os = "linux")]
fn apply_webkit_workarounds() {
    if std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
        // Safe here and nowhere later: this runs before the builder, so no
        // other thread exists to observe the environment changing.
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_webkit_workarounds() {}

pub fn run() {
    apply_webkit_workarounds();

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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // The sign-in listener's state: one waiting listener at most, and the
        // handle `oauth_cancel` needs to stop it.
        .manage(oauth::Listener::default())
        .invoke_handler(tauri::generate_handler![
            idle_seconds,
            oauth::oauth_listen,
            oauth::oauth_cancel,
            agents::agent_inspect,
            agents::agent_add,
            agents::agent_server_install
        ])
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
        .build(tauri::generate_context!())
        .expect("failed to start the ToHoot desktop shell")
        .run(|app, event| {
            // A click on the Dock icon. Closing the window only hid it, so
            // without this the Dock icon of a running app would do nothing.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                focus_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The menu bar icon is drawn on macOS only, but checked everywhere: a path
    /// or a PNG the macro cannot read would otherwise fail the build on the one
    /// platform nobody here builds on.
    #[test]
    fn the_menu_bar_icon_decodes() {
        let icon = tauri::include_image!("icons/tray-template.png");
        assert_eq!((icon.width(), icon.height()), (64, 64));
        // A template is black and clear: every pixel's colour is black.
        assert!(icon.rgba().chunks(4).all(|px| px[0] == 0 && px[1] == 0 && px[2] == 0));
    }

    /// Both halves of the rule, since getting either wrong is silent: a missing
    /// variable is a blank window on NVIDIA, and overwriting an explicit one
    /// takes away the only way to turn the workaround off.
    #[test]
    #[cfg(target_os = "linux")]
    fn sets_the_nvidia_workaround_only_when_unset() {
        std::env::remove_var("__NV_DISABLE_EXPLICIT_SYNC");
        apply_webkit_workarounds();
        assert_eq!(
            std::env::var("__NV_DISABLE_EXPLICIT_SYNC").as_deref(),
            Ok("1")
        );

        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "0");
        apply_webkit_workarounds();
        assert_eq!(
            std::env::var("__NV_DISABLE_EXPLICIT_SYNC").as_deref(),
            Ok("0")
        );

        std::env::remove_var("__NV_DISABLE_EXPLICIT_SYNC");
    }
}
