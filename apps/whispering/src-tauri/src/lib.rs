use log::{info, warn};
use tauri::Manager;
use tauri_plugin_aptabase::EventTracker;
use tauri_plugin_log::{Target, TargetKind};

pub mod recorder;
use recorder::commands::{
    cancel_recording, close_recording_session, enumerate_recording_devices,
    get_current_recording_id, init_recording_session, start_recording, stop_recording, AppData,
};

pub mod transcription;
use transcription::{
    transcribe_audio_moonshine, transcribe_audio_parakeet, transcribe_audio_whisper, ModelManager,
};

pub mod windows_path;
use windows_path::fix_windows_path;

pub mod graceful_shutdown;
use graceful_shutdown::send_sigint;

pub mod command;
use command::{execute_command, spawn_command};

pub mod markdown;
use markdown::{count_markdown_files, delete_files_in_directory, read_markdown_files, write_markdown_files};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[tokio::main]
pub async fn run() {
    // Set up panic hook to capture crash information before the app exits.
    // The previous hook is preserved so default panic reporting still occurs.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        use std::backtrace::Backtrace;
        let payload = panic_info.payload();
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let thread_name = std::thread::current()
            .name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unnamed thread".to_string());

        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic payload".to_string()
        };

        let backtrace = Backtrace::force_capture();

        eprintln!(
            "[panic] thread={} location={} message={}",
            thread_name, location, message
        );
        eprintln!("{}", backtrace);

        // Write crash log to temp directory (works on all platforms)
        {
            use std::fs::OpenOptions;
            use std::io::Write;
            let crash_log_path = std::env::temp_dir().join("whispering-crash.log");
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&crash_log_path)
            {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = writeln!(
                    file,
                    "[{}] thread={} location={} message={}",
                    timestamp, thread_name, location, message
                );
                let _ = writeln!(file, "{}", backtrace);
                let _ = writeln!(file, "-----");
            }
        }

        previous_hook(panic_info);
    }));

    // Fix PATH environment for GUI applications on macOS and Linux
    // This ensures commands like ffmpeg installed via Homebrew are accessible
    let _ = fix_path_env::fix();

    // Fix Windows PATH inheritance bug
    // This ensures child processes can find ffmpeg on Windows
    fix_windows_path();

    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("whispering::transcription", log::LevelFilter::Debug)
        .target(Target::new(TargetKind::Stdout))
        .target(Target::new(TargetKind::LogDir {
            file_name: Some("whispering".to_string()),
        }))
        .build();

    let mut builder = tauri::Builder::default().plugin(log_plugin);

    // Try to get APTABASE_KEY from environment, use empty string if not found
    let aptabase_key = option_env!("APTABASE_KEY").unwrap_or("");

    // Only add Aptabase plugin if key is not empty
    if !aptabase_key.is_empty() {
        info!("Aptabase analytics enabled");
        builder = builder.plugin(tauri_plugin_aptabase::Builder::new(aptabase_key).build());
    } else {
        warn!("APTABASE_KEY not found, analytics disabled");
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
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                let _ = app
                    .get_webview_window("main")
                    .expect("no main window")
                    .set_focus();
            }));
    }

    // Register command handlers (same for all platforms now)
    let builder = builder.invoke_handler(tauri::generate_handler![
        write_text,
        simulate_enter_keystroke,
        simulate_accelerator,
        get_is_simulating,
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
        transcribe_audio_moonshine,
        send_sigint,
        // Command execution (prevents console window flash on Windows)
        execute_command,
        spawn_command,
        // Filesystem utilities
        read_markdown_files,
        count_markdown_files,
        delete_files_in_directory,
        write_markdown_files,
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

use std::sync::atomic::Ordering;
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

/// Simulates pressing the Enter/Return key
///
/// This is useful for automatically submitting text in chat applications
/// after transcription has been pasted.
#[tauri::command]
async fn simulate_enter_keystroke() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Use Direction::Click for a combined press+release action
    enigo
        .key(Key::Return, Direction::Click)
        .map_err(|e| format!("Failed to simulate Enter key: {}", e))?;

    Ok(())
}

/// Simulates a keyboard accelerator (shortcut)
///
/// This is used for "passthrough" global shortcuts where Whispering needs to
/// re-emit the key combination so other applications can receive it.
#[tauri::command]
async fn simulate_accelerator(
    state: tauri::State<'_, AppData>,
    accelerator: String,
) -> Result<(), String> {
    state.is_simulating.store(true, Ordering::SeqCst);

    let result = async {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

        let parts: Vec<&str> = accelerator.split('+').collect();
        let mut modifiers = Vec::new();

        for i in 0..parts.len() - 1 {
            let m = parts[i];
            let key = match m {
                "Command" | "Cmd" | "Meta" => Key::Meta,
                "Control" | "Ctrl" => Key::Control,
                "Alt" | "Option" => Key::Alt,
                "Shift" => Key::Shift,
                "Super" => Key::Meta,
                "CommandOrControl" | "CmdOrCtrl" => {

                    #[cfg(target_os = "macos")]
                    {
                        Key::Meta
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        Key::Control
                    }
                }
                _ => continue,
            };
            modifiers.push(key);
        }

        let last_part = parts.last().ok_or("Invalid accelerator")?;
        let main_key = match *last_part {
            "Enter" | "Return" => Key::Return,
            "Tab" => Key::Tab,
            "Space" => Key::Space,
            "Backspace" => Key::Backspace,
            "Delete" => Key::Delete,
            "Insert" => Key::Insert,
            "Home" => Key::Home,
            "End" => Key::End,
            "PageUp" => Key::PageUp,
            "PageDown" => Key::PageDown,
            "Up" => Key::UpArrow,
            "Down" => Key::DownArrow,
            "Left" => Key::LeftArrow,
            "Right" => Key::RightArrow,
            "Escape" | "Esc" => Key::Escape,
            "F1" => Key::F1,
            "F2" => Key::F2,
            "F3" => Key::F3,
            "F4" => Key::F4,
            "F5" => Key::F5,
            "F6" => Key::F6,
            "F7" => Key::F7,
            "F8" => Key::F8,
            "F9" => Key::F9,
            "F10" => Key::F10,
            "F11" => Key::F11,
            "F12" => Key::F12,
            "Plus" => Key::Unicode('+'),
            ";" => Key::Unicode(';'),
            "'" => Key::Unicode('\''),
            "," => Key::Unicode(','),
            "." => Key::Unicode('.'),
            "/" => Key::Unicode('/'),
            "\\" => Key::Unicode('\\'),
            "[" => Key::Unicode('['),
            "]" => Key::Unicode(']'),
            "`" => Key::Unicode('`'),
            "-" => Key::Unicode('-'),
            "=" => Key::Unicode('='),
            _ if last_part.len() == 1 => {
                let c = last_part.chars().next().unwrap();
                Key::Unicode(c.to_ascii_lowercase())
            }
            _ => return Err(format!("Unsupported key: {}", last_part)),
        };

        // 1. Press all modifiers
        for &m in &modifiers {
            enigo
                .key(m, Direction::Press)
                .map_err(|e| format!("Failed to press modifier: {}", e))?;
        }

        // 2. Click main key
        enigo
            .key(main_key, Direction::Click)
            .map_err(|e| format!("Failed to click main key: {}", e))?;

        // 3. Release all modifiers in reverse order
        for &m in modifiers.iter().rev() {
            enigo
                .key(m, Direction::Release)
                .map_err(|e| format!("Failed to release modifier: {}", e))?;
        }

        Ok(())
    }
    .await;

    // Small sleep to ensure the OS has processed the simulated events
    // before we reset the flag.
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    state.is_simulating.store(false, Ordering::SeqCst);

    result
}

/// Returns whether a keyboard simulation is currently in progress
#[tauri::command]
async fn get_is_simulating(state: tauri::State<'_, AppData>) -> Result<bool, String> {
    Ok(state.is_simulating.load(Ordering::SeqCst))
}
