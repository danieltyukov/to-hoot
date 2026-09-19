//! A one-shot HTTP listener on the loopback interface, for signing in.
//!
//! Signing in with Google or Cloudflare opens a page in the person's own
//! browser, and the only way that page can hand the app an authorization code
//! is to redirect the browser to an address the app is listening on. Both
//! services accept `http://localhost:<port>/oauth/callback`; Cloudflare accepts
//! nothing else, and pins the port to 8976, which is what its command-line tool
//! wrangler listens on. So the app listens there too, for exactly one request,
//! and answers it with a page that says to come back to the app.
//!
//! The webview cannot do this itself: a page has no way to open a socket. It is
//! a command for the same reason the idle counter is one.

use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::State;

/// The port Cloudflare's sign-in redirects to. Not configurable, because the
/// redirect URI is registered on their side.
pub const PORT: u16 = 8976;
pub const PATH: &str = "/oauth/callback";

/// One listener at a time, and a way to stop it. Two sign-ins at once would
/// fight for the same port and one would fail with a message about the socket
/// rather than about the sign-in. What is held is the cancel flag of the wait
/// in progress; the socket itself lives on the blocking thread.
#[derive(Default)]
pub struct Listener(Mutex<Option<Arc<AtomicBool>>>);

/// What the browser is shown once the code has been captured. Plain and short,
/// because it is on screen for a second before the person switches back.
const DONE_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>ToHoot</title>\
<style>body{font-family:system-ui,sans-serif;background:#faf8f5;color:#1c1b19;display:grid;place-items:center;height:100vh;margin:0}\
p{font-size:18px}</style></head><body><p>Signed in. You can close this tab and go back to ToHoot.</p></body></html>";

const NOT_FOUND_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>ToHoot</title></head>\
<body><p>Not the sign-in callback. You can close this tab.</p></body></html>";

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

/// The request line's target, or None when the bytes are not an HTTP request.
fn request_target(stream: &mut TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    BufReader::new(&*stream).read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    if method != "GET" {
        return None;
    }
    Some(target.to_string())
}

/// Waits for the browser's redirect and returns the full URL it arrived on.
///
/// Blocking, on a blocking thread: `accept` has no async form without a
/// runtime this shell does not otherwise need. A blocked accept cannot be
/// interrupted from outside, so `oauth_cancel` raises a flag and then connects
/// to the port itself; the loop wakes on that connection, sees the flag, and
/// returns. The socket is dropped with the thread, which frees the port.
#[tauri::command]
pub async fn oauth_listen(listener: State<'_, Listener>) -> Result<String, String> {
    let socket = TcpListener::bind(("127.0.0.1", PORT))
        .map_err(|err| format!("could not listen on port {PORT}: {err}"))?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = listener.0.lock().map_err(|_| "listener lock poisoned".to_string())?;
        if slot.is_some() {
            return Err("a sign-in is already waiting for the browser".to_string());
        }
        *slot = Some(Arc::clone(&cancel));
    }

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        loop {
            let (mut stream, _) = socket
                .accept()
                .map_err(|err| format!("the sign-in listener stopped: {err}"))?;
            if cancel.load(Ordering::SeqCst) {
                respond(&mut stream, "400 Bad Request", NOT_FOUND_PAGE);
                return Err("Sign-in cancelled.".to_string());
            }
            let Some(target) = request_target(&mut stream) else {
                respond(&mut stream, "400 Bad Request", NOT_FOUND_PAGE);
                continue;
            };
            // Browsers ask for a favicon, and a stray tab can ask for anything.
            // Only the callback path ends the wait.
            if !target.starts_with(PATH) {
                respond(&mut stream, "404 Not Found", NOT_FOUND_PAGE);
                continue;
            }
            respond(&mut stream, "200 OK", DONE_PAGE);
            return Ok(format!("http://localhost:{PORT}{target}"));
        }
    })
    .await
    .map_err(|err| format!("the sign-in listener panicked: {err}"))?;

    if let Ok(mut slot) = listener.0.lock() {
        *slot = None;
    }
    result
}

/// Stops a waiting `oauth_listen`: raises its flag, then connects to the port
/// so the blocked accept wakes up and reads it.
#[tauri::command]
pub fn oauth_cancel(listener: State<'_, Listener>) -> Result<(), String> {
    let taken = {
        let mut slot = listener.0.lock().map_err(|_| "listener lock poisoned".to_string())?;
        slot.take()
    };
    if let Some(cancel) = taken {
        cancel.store(true, Ordering::SeqCst);
        let poke = SocketAddr::from(([127, 0, 0, 1], PORT));
        let _ = TcpStream::connect_timeout(&poke, Duration::from_millis(500));
    }
    Ok(())
}
