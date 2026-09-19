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

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    /// Milliseconds since the last keyboard or mouse input on this session,
    /// from the counter Windows itself uses for the screensaver. The tick
    /// count wraps every 49.7 days; the subtraction wraps with it.
    pub fn seconds() -> Option<f64> {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info` is a correctly sized, writable LASTINPUTINFO, which is
        // all GetLastInputInfo requires; a zero return means it wrote nothing.
        let ok = unsafe { GetLastInputInfo(&mut info) };
        if ok == 0 {
            return None;
        }
        // SAFETY: GetTickCount takes no arguments and cannot fail.
        let now = unsafe { GetTickCount() };
        Some(f64::from(now.wrapping_sub(info.dwTime)) / 1000.0)
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    pub fn seconds() -> Option<f64> {
        None
    }
}
