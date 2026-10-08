//! DevWorkspace — a local-first developer command center.
//!
//! Layering, outermost first:
//!
//! ```text
//! UI (React)  ->  commands  ->  detect / git / runner / system  ->  store
//! ```
//!
//! `commands` is the only module the UI can reach. The service modules know
//! nothing about Tauri, which is what makes them directly testable.

pub mod commands;
pub mod detect;
pub mod error;
pub mod git;
pub mod model;
pub mod runner;
pub mod store;
pub mod system;

use commands::AppState;
use store::JsonFileStore;
use tauri::Manager;

/// Builds and runs the application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The workspace document lives beside the app's other config.
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let store = JsonFileStore::new(dir.join("workspace.json"));

            let state = AppState::new(Box::new(store)).map_err(|e| {
                // A store we cannot even read is the one thing worth failing on.
                std::io::Error::other(e.to_string())
            })?;
            app.manage(state);

            // Showing the window only once the view is ready avoids a flash of
            // an unstyled, empty frame on launch.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Processes we started are ours to clean up; a `dev` server must
            // not outlive the window that launched it.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<AppState>() {
                    state.0.runs.cancel_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_workspace,
            commands::add_project,
            commands::remove_project,
            commands::update_project,
            commands::set_last_project,
            commands::add_command,
            commands::update_command,
            commands::remove_command,
            commands::sync_detected_commands,
            commands::project_status,
            commands::run_command,
            commands::cancel_run,
            commands::active_runs,
            commands::save_settings,
            commands::log_activity,
            commands::clear_activity,
            commands::storage_info,
            commands::reveal_storage,
            commands::available_editors,
            commands::open_in_editor,
            commands::open_project_folder,
            commands::open_project_terminal,
            commands::open_repository,
        ])
        .run(tauri::generate_context!())
        .expect("DevWorkspace failed to start");
}
