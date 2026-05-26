use log::{info, warn};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_aptabase::EventTracker;
use tauri_plugin_log::{Target, TargetKind};

pub mod audio;
use audio::encode_upload_audio;
pub mod recorder;
use recorder::commands::{
    cancel_recording, close_recording_session, enumerate_recording_devices,
    get_current_recording_id, init_recording_session, start_recording, stop_recording,
};
use recorder::recorder::Recorder;

pub mod transcription;
use transcription::{set_unload_policy, transcribe_audio, ModelManager};

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

    // Fix PATH environment for GUI applications on macOS and Linux.
    // Tauri-launched processes don't inherit the user's shell PATH, so any
    // command we spawn (Homebrew-installed binaries, etc.) needs this.
    let _ = fix_path_env::fix();

    // Fix Windows PATH inheritance bug so spawned child processes resolve
    // commands from PATH the same way the parent does.
    fix_windows_path();

    // ONNX Runtime accelerator for Parakeet and Moonshine. `OrtAccelerator::Auto`
    // picks the best provider that's compiled in (CoreML on macOS, CPU on Linux),
    // but it deliberately excludes DirectML because DirectML needs sequential ORT
    // session settings that would penalize other backends. So on Windows we
    // select DirectML explicitly to honor the compiled-in `ort-directml` feature.
    // transcribe-rs always appends CPU to the EP list, so a CoreML or DirectML
    // init failure degrades to CPU rather than failing the transcription. Set
    // `ORT_LOG_SEVERITY_LEVEL=0` to confirm which EP ORT actually selected.
    #[cfg(target_os = "windows")]
    transcribe_rs::accel::set_ort_accelerator(transcribe_rs::accel::OrtAccelerator::DirectMl);

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
        .manage(Mutex::new(Recorder::new()))
        .manage(ModelManager::new())
        .setup(|app| {
            // Start the model idle watcher. It runs on the Tauri async
            // runtime, sleeps between checks, and drops the resident
            // model when the configured idle timeout elapses.
            let manager = app.state::<ModelManager>().inner().clone();
            manager.start_idle_watcher();
            Ok(())
        });

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
        // Audio recorder commands
        get_current_recording_id,
        enumerate_recording_devices,
        init_recording_session,
        close_recording_session,
        start_recording,
        stop_recording,
        cancel_recording,
        transcribe_audio,
        encode_upload_audio,
        set_unload_policy,
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

    // 3. Simulate paste operation
    #[cfg(target_os = "linux")]
    {
        // On Linux, use xdotool instead of enigo for reliable key simulation.
        // xdotool --clearmodifiers prevents stuck modifier keys from interfering
        // and --window targets the correct window regardless of focus changes.
        let target_window = std::process::Command::new("xdotool")
            .args(["getactivewindow"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string());

        // Detect terminals by WM_CLASS — they need Ctrl+Shift+V instead of Ctrl+V.
        // xprop output format: WM_CLASS(STRING) = "instance", "class"
        // We extract only the quoted values to avoid false matches on the
        // "STRING" prefix (e.g. "st" matching "STRING").
        let is_terminal = target_window
            .as_ref()
            .and_then(|id| {
                std::process::Command::new("xprop")
                    .args(["-id", id, "WM_CLASS"])
                    .output()
                    .ok()
            })
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|raw| {
                // Extract the values after "=" and check only those
                let values = raw
                    .split('=')
                    .nth(1)
                    .unwrap_or("")
                    .to_lowercase();
                [
                    "gnome-terminal",
                    "konsole",
                    "xfce4-terminal",
                    "mate-terminal",
                    "terminator",
                    "tilix",
                    "alacritty",
                    "kitty",
                    "wezterm",
                    "foot",
                    "st-256color",
                    "st",
                    "urxvt",
                    "xterm",
                    "sakura",
                    "guake",
                    "yakuake",
                    "tilda",
                    "hyper",
                    "termux",
                    "rio",
                    "ghostty",
                    "contour",
                    "blackbox",
                ]
                .iter()
                .any(|t| {
                    // For short names like "st", match exact quoted values
                    // to avoid substring false positives
                    if t.len() <= 3 {
                        values.contains(&format!("\"{}\"", t))
                    } else {
                        values.contains(*t)
                    }
                })
                    || values.contains("terminal")
                    || values.contains("term")
            })
            .unwrap_or(false);

        let paste_key = if is_terminal {
            "ctrl+shift+v"
        } else {
            "ctrl+v"
        };

        info!(
            "write_text: target_window={:?}, is_terminal={}, paste_key={}",
            target_window, is_terminal, paste_key
        );

        // Refocus the target window in case focus shifted during clipboard operations.
        // Also dismiss any active menus (Alt-based shortcuts can activate menu bars).
        if let Some(ref id) = target_window {
            let _ = std::process::Command::new("xdotool")
                .args(["windowactivate", "--sync", id])
                .output();
            let _ = std::process::Command::new("xdotool")
                .args(["key", "--clearmodifiers", "Escape"])
                .output();
            // Small delay for the app to process the Escape and restore focus
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        std::process::Command::new("xdotool")
            .args(["key", "--clearmodifiers", paste_key])
            .output()
            .map_err(|e| format!("Failed to simulate paste via xdotool: {}", e))?;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

        #[cfg(target_os = "macos")]
        let (modifier, v_key) = (Key::Meta, Key::Other(9));
        #[cfg(target_os = "windows")]
        let (modifier, v_key) = (Key::Control, Key::Other(0x56));

        enigo
            .key(modifier, Direction::Press)
            .map_err(|e| format!("Failed to press modifier key: {}", e))?;
        enigo
            .key(v_key, Direction::Press)
            .map_err(|e| format!("Failed to press V key: {}", e))?;
        enigo
            .key(v_key, Direction::Release)
            .map_err(|e| format!("Failed to release V key: {}", e))?;
        enigo
            .key(modifier, Direction::Release)
            .map_err(|e| format!("Failed to release modifier key: {}", e))?;
    }

    // Delay before restoring clipboard — heavy apps like VS Code (Electron) need
    // more time to process the paste event and read the clipboard content.
    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

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
