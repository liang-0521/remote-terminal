#[cfg(not(target_os = "windows"))]
compile_error!("Remote Terminal 0.5.1 is a Windows-only desktop client.");

mod backend;
mod command_history;
mod commands;
mod credentials;
mod data_directory;
mod error;
mod lifecycle;
mod monitor;
mod ssh;
mod state;
mod storage;
mod tray;

use backend::BackendState;
use state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // Official guidance requires single-instance to be registered first.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Err(error) = lifecycle::restore_main_window(app) {
                eprintln!(
                    "[remote-terminal] restore existing app instance: {}",
                    error.code
                );
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let previous_default_data_directory = app.path().app_data_dir()?.join("data");
            let default_data_directory =
                data_directory::current_install_data_directory().map_err(std::io::Error::other)?;
            let app_state = AppState::load(
                settings_path,
                default_data_directory,
                previous_default_data_directory,
            )
            .map_err(std::io::Error::other)?;
            let data_directory = app_state.active_data_directory();
            let legacy_data_directory = app
                .path()
                .config_dir()?
                .join("remote-terminal")
                .join("data");
            let backend_state = BackendState::initialize(
                app.handle().clone(),
                &legacy_data_directory,
                data_directory,
            )
            .map_err(std::io::Error::other)?;
            if !app.manage(app_state) {
                return Err(std::io::Error::other("application state already registered").into());
            }
            if !app.manage(backend_state) {
                return Err(std::io::Error::other("backend state already registered").into());
            }
            if let Err(error) = lifecycle::restore_saved_window_placement(app.handle()) {
                eprintln!("[remote-terminal] restore window placement: {}", error.code);
            }
            tray::setup(app)?;
            Ok(())
        })
        .on_window_event(lifecycle::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::get_close_behavior,
            commands::set_close_behavior,
            commands::get_ui_preferences,
            commands::set_ui_preferences,
            commands::resolve_close_request,
            commands::show_main_window,
            commands::quit_app,
            commands::get_backend_status,
            commands::data_directory_status,
            commands::data_directory_change,
            commands::connections_list,
            commands::connections_save,
            commands::connections_remove,
            commands::credentials_status,
            commands::credentials_remove,
            commands::host_keys_probe,
            commands::host_keys_accept,
            commands::ssh_connect,
            commands::ssh_disconnect,
            commands::terminal_attach,
            commands::terminal_write,
            commands::terminal_resize,
            commands::completion_catalog,
            commands::command_history_list,
            commands::command_history_record,
            commands::command_history_remove,
            commands::sftp_list,
            commands::sftp_read_text,
            commands::sftp_write_text,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_create,
            commands::sftp_upload,
            commands::sftp_download_to_computer,
            commands::sftp_cancel,
            commands::sftp_retry,
            commands::monitor_sample,
            commands::updates_install,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Remote Terminal");
}
