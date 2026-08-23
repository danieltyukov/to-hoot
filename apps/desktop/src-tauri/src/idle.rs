//! Seconds since the OS last saw input from the user.
//!
//! The webview cannot answer this: it sees its own window's events and nothing
//! else, so a user who spent twenty minutes in another application looks busy.
//! Tracking time honestly needs the OS-level number, which is why it is a
//! command rather than a browser API.

/// Zero means "no idle information", which reads as "active".
///
/// That is the safe direction to be wrong in. Overreporting idleness would take
/// time off a task the user was actually working on; underreporting only defers
/// the question to the wall-clock gap check, which catches sleep and shutdown
/// regardless.
pub fn seconds() -> f64 {
    platform::seconds().unwrap_or(0.0)
}

#[cfg(target_os = "linux")]
mod platform {
    use x11rb::connection::Connection;
    use x11rb::protocol::screensaver::ConnectionExt as _;

    /// Reads the X11 screensaver extension's idle counter.
    ///
    /// Under Wayland this goes through XWayland, where the counter tracks only
    /// what XWayland itself saw. It is right on an X11 session and conservative
    /// on a Wayland one, which is the correct way round.
    pub fn seconds() -> Option<f64> {
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        let info = conn.screensaver_query_info(root).ok()?.reply().ok()?;
        Some(f64::from(info.ms_since_user_input) / 1000.0)
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    pub fn seconds() -> Option<f64> {
        None
    }
}
