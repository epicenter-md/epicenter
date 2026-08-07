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

pub mod markdown_reader;
use markdown_reader::{bulk_delete_files, count_markdown_files, read_markdown_files};

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

    // When "menu bar only" is enabled, clicking the window's close button
    // should hide the window (like a normal menu-bar app) instead of quitting
    // the whole process. Real quit still happens via the tray menu's Quit item.
    builder = builder.setup(|app| {
        if let Some(window) = app.get_webview_window("main") {
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if HIDE_DOCK_ICON.load(std::sync::atomic::Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                }
            });
        }
        Ok(())
    });

    // Register command handlers (same for all platforms now)
    let builder = builder.invoke_handler(tauri::generate_handler![
        write_text,
        simulate_enter_keystroke,
        set_dock_icon_visible,
        quit_app,
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
        bulk_delete_files,
    ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |handler, event| {
        // Only track events if Aptabase is enabled (key is not empty)
        if !aptabase_key.is_empty() {
            match &event {
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

        // Cmd+Q / "Quit Whispering" from the app menu bypasses the window's
        // CloseRequested event entirely and goes straight to ExitRequested.
        // In "menu bar only" mode, treat it the same as closing the window —
        // unless quit_app requested a real, intentional exit (tray Quit item).
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            let intentional_quit = INTENTIONAL_QUIT.load(std::sync::atomic::Ordering::Relaxed);
            if !intentional_quit && HIDE_DOCK_ICON.load(std::sync::atomic::Ordering::Relaxed) {
                api.prevent_exit();
                if let Some(window) = handler.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
        }

        // macOS fires Reopen when the user clicks the Dock icon (or the tray
        // icon's "Show Window" item re-triggers activation) while the window
        // is hidden. Without this, a hidden window becomes unreachable.
        if let tauri::RunEvent::Reopen { .. } = &event {
            if let Some(window) = handler.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
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

/// Shared with the window-close and app-exit handlers in `run()`: when true,
/// closing the window or pressing Cmd+Q hides the window instead of quitting,
/// matching normal menu-bar-app behavior (the app only truly quits via the
/// tray menu's Quit item).
static HIDE_DOCK_ICON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Set by `quit_app` right before requesting a real exit, so the
/// `ExitRequested` handler in `run()` can tell an intentional Quit (from the
/// tray menu) apart from macOS routing Cmd+Q / window-close through the same
/// event when "menu bar only" is active — otherwise that handler would just
/// hide the window forever instead of letting the app actually quit.
static INTENTIONAL_QUIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Shows or hides the app's Dock icon (and Cmd+Tab/task switcher entry).
///
/// On macOS this toggles the activation policy between `Regular` (normal app
/// with a Dock icon) and `Accessory` (menu-bar-only app, no Dock icon, no
/// window switcher entry). The app remains fully usable via the system tray
/// icon in either mode. No-op on platforms without a Dock (Windows/Linux).
#[tauri::command]
async fn set_dock_icon_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    HIDE_DOCK_ICON.store(!visible, std::sync::atomic::Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        app.set_activation_policy(policy)
            .map_err(|e| format!("Failed to set activation policy: {}", e))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
    }

    Ok(())
}

/// Quits the app for real, bypassing the "menu bar only" close-to-tray
/// behavior. This is what the tray menu's Quit item calls instead of the
/// generic process-plugin exit, which gets intercepted the same as a window
/// close when "menu bar only" is active.
#[tauri::command]
async fn quit_app(app: tauri::AppHandle) -> Result<(), String> {
    INTENTIONAL_QUIT.store(true, std::sync::atomic::Ordering::Relaxed);
    app.exit(0);
    Ok(())
}
