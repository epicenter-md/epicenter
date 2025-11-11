
use tauri::Manager;
use tauri_plugin_aptabase::EventTracker;

pub mod recorder;
use recorder::commands::{
    cancel_recording, close_recording_session, enumerate_recording_devices,
    get_current_recording_id, init_recording_session, start_recording, stop_recording, AppData,
};

pub mod transcription;
use transcription::{transcribe_audio_whisper, transcribe_audio_parakeet, ModelManager};

pub mod windows_path;
use windows_path::fix_windows_path;

pub mod graceful_shutdown;
use graceful_shutdown::send_sigint;

pub mod command;
use command::{execute_command, spawn_command};

pub mod markdown_reader;
use markdown_reader::{count_markdown_files, read_markdown_files};


#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[tokio::main]
pub async fn run() {
    // Fix PATH environment for GUI applications on macOS and Linux
    // This ensures commands like ffmpeg installed via Homebrew are accessible
    let _ = fix_path_env::fix();
    
    // Fix Windows PATH inheritance bug
    // This ensures child processes can find ffmpeg on Windows
    fix_windows_path();
    
    let mut builder = tauri::Builder::default();

    // Try to get APTABASE_KEY from environment, use empty string if not found
    let aptabase_key = option_env!("APTABASE_KEY").unwrap_or("");

    // Only add Aptabase plugin if key is not empty
    if !aptabase_key.is_empty() {
        println!("Aptabase analytics enabled");
        builder = builder.plugin(tauri_plugin_aptabase::Builder::new(aptabase_key).build());
    } else {
        println!("Warning: APTABASE_KEY not found, analytics disabled");
    }

    builder = builder
        .plugin(tauri_plugin_macos_permissions::init())
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
        .manage(AppData::new())
        .manage(ModelManager::new());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                let _ = app
                    .get_webview_window("main")
                    .expect("no main window")
                    .set_focus();
            }))
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }

    // Register command handlers (same for all platforms now)
    let builder = builder.invoke_handler(tauri::generate_handler![
        write_text,
        // Audio recorder commands
        get_current_recording_id,
        enumerate_recording_devices,
        init_recording_session,
        close_recording_session,
        start_recording,
        stop_recording,
        cancel_recording,
        transcribe_audio_whisper,
        transcribe_audio_parakeet,
        send_sigint,
        // Command execution (prevents console window flash on Windows)
        execute_command,
        spawn_command,
        // Filesystem utilities
        read_markdown_files,
        count_markdown_files,
    ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handler, event| {
        // Only track events if Aptabase is enabled (key is not empty)
        if !aptabase_key.is_empty() {
            match event {
                tauri::RunEvent::Exit { .. } => {
                    let _ = handler.track_event("app_exited", None);
                    handler.flush_events_blocking();
                }
                tauri::RunEvent::Ready { .. } => {
                    let _ = handler.track_event("app_started", None);
                }
                _ => {}
            }
        }
    });
}

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Writes text at the cursor position using the clipboard sandwich technique
///
/// This method preserves the user's existing clipboard content by:
/// 1. Saving the current clipboard content
/// 2. Writing the new text to clipboard
/// 3. Simulating a paste operation (Cmd+V on macOS, Ctrl+V elsewhere)
/// 4. Restoring the original clipboard content
///
/// This approach is faster than typing character-by-character and preserves
/// the user's clipboard, making it ideal for inserting transcribed text.
#[tauri::command]
async fn write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    // 1. Save current clipboard content
    let original_clipboard = app.clipboard().read_text().ok();

    // 2. Write new text to clipboard
    app.clipboard()
        .write_text(&text)
        .map_err(|e| format!("Failed to write to clipboard: {}", e))?;

    // Small delay to ensure clipboard is updated
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // 3. Simulate paste operation using virtual key codes (layout-independent)
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    
    // Use virtual key codes for V to work with any keyboard layout
    #[cfg(target_os = "macos")]
    let (modifier, v_key) = (Key::Meta, Key::Other(9)); // Virtual key code for V on macOS
    #[cfg(target_os = "windows")]
    let (modifier, v_key) = (Key::Control, Key::Other(0x56)); // VK_V on Windows
    #[cfg(target_os = "linux")]
    let (modifier, v_key) = (Key::Control, Key::Unicode('v')); // Fallback for Linux

    // Press modifier + V
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {}", e))?;
    enigo
        .key(v_key, Direction::Press)
        .map_err(|e| format!("Failed to press V key: {}", e))?;
    
    // Release V + modifier (in reverse order for proper cleanup)
    enigo
        .key(v_key, Direction::Release)
        .map_err(|e| format!("Failed to release V key: {}", e))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {}", e))?;

    // Small delay to ensure paste completes
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // 4. Restore original clipboard content
    if let Some(content) = original_clipboard {
        app.clipboard()
            .write_text(&content)
            .map_err(|e| format!("Failed to restore clipboard: {}", e))?;
    }

    Ok(())
}

