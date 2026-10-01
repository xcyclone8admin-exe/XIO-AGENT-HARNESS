// Release builds are GUI-subsystem: no console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    xyra_desktop_lib::run();
}
