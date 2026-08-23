// Keeps a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    to_hoot_desktop_lib::run()
}
