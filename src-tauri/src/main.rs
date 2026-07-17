#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
compile_error!("Remote Terminal 0.5.1 is a Windows-only desktop client.");

fn main() {
    remote_terminal_lib::run();
}
