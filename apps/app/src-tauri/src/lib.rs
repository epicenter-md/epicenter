// Platform-specific modules
#[cfg(target_os = "macos")]
mod accessibility;

// Re-export platform-specific functions
#[cfg(target_os = "macos")]
use accessibility::{is_macos_accessibility_enabled, open_apple_accessibility};

pub mod recorder;
use recorder::commands::{
    cancel_recording, close_recording_session, enumerate_recording_devices, get_recorder_state,
    init_recording_session, start_recording, stop_recording, AppData,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(AppData::new());

    // When a new instance is opened, focus on the main window if it's already running
    // https://v2.tauri.app/plugin/single-instance/#focusing-on-new-instance
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    // Platform-specific command handlers
    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        write_text,
        open_apple_accessibility,
        is_macos_accessibility_enabled,
        // Audio recorder commands
        get_recorder_state,
        enumerate_recording_devices,
        init_recording_session,
        close_recording_session,
        start_recording,
        stop_recording,
        cancel_recording,
    ]);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        write_text,
        // Audio recorder commands
        get_recorder_state,
        enumerate_recording_devices,
        init_recording_session,
        close_recording_session,
        start_recording,
        stop_recording,
        cancel_recording,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Paste text into the active application using the clipboard and a paste
/// keyboard shortcut. Falls back to simulating keystrokes with Enigo.
#[tauri::command]
fn write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    if let Err(err) = app.clipboard().write_text(&text) {
        return Err(err.to_string());
    }

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo.key(modifier, Direction::Release).map_err(|e| e.to_string())?;

    Ok(())
}
