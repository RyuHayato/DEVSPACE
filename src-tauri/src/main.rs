// Release builds are GUI-only: no console window should appear on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    devworkspace_lib::run()
}
