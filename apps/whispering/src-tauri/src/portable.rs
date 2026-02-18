use log::info;
use std::path::PathBuf;
use tauri::Manager;

/// Returns the path to the portable data directory if running in portable mode.
///
/// Portable mode is detected by checking for a `portable` marker file (any extension
/// or no extension) next to the executable. When found, the data directory is
/// `{exe_dir}/data/`.
///
/// This enables the app to run from a USB drive with all data stored alongside
/// the executable, rather than in the platform-specific app data directory.
fn get_portable_data_path() -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok()?;
    let exe_dir = exe_path.parent()?;

    // Check for a `portable` marker file (no extension)
    let portable_marker = exe_dir.join("portable");
    if portable_marker.exists() {
        let data_dir = exe_dir.join("data");
        return Some(data_dir);
    }

    // Also check for `portable.txt` as an alternative marker
    let portable_txt = exe_dir.join("portable.txt");
    if portable_txt.exists() {
        let data_dir = exe_dir.join("data");
        return Some(data_dir);
    }

    None
}

/// Returns the base data directory for the application.
///
/// In portable mode (when a `portable` or `portable.txt` file exists next to the
/// executable), returns `{exe_dir}/data/` and ensures the directory exists.
///
/// In normal mode, returns the platform-specific app data directory:
/// - macOS: `~/Library/Application Support/com.bradenwong.whispering/`
/// - Windows: `%APPDATA%/com.bradenwong.whispering/`
/// - Linux: `~/.config/com.bradenwong.whispering/`
#[tauri::command]
pub fn get_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(portable_dir) = get_portable_data_path() {
        // Create the data directory if it doesn't exist
        std::fs::create_dir_all(&portable_dir).map_err(|e| {
            format!(
                "Failed to create portable data directory '{}': {}",
                portable_dir.display(),
                e
            )
        })?;
        info!(
            "Portable mode: using data directory '{}'",
            portable_dir.display()
        );
        return Ok(portable_dir.to_string_lossy().to_string());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    Ok(app_data_dir.to_string_lossy().to_string())
}

/// Returns whether the application is running in portable mode.
#[tauri::command]
pub fn is_portable_mode() -> bool {
    get_portable_data_path().is_some()
}

/// Reads settings from the portable settings file.
///
/// Returns the contents of `{data_dir}/settings.json` if it exists, or null if
/// the file doesn't exist or isn't readable.
#[tauri::command]
pub fn read_portable_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    if let Some(portable_dir) = get_portable_data_path() {
        let settings_path = portable_dir.join("settings.json");
        if settings_path.exists() {
            let contents = std::fs::read_to_string(&settings_path).map_err(|e| {
                format!(
                    "Failed to read portable settings from '{}': {}",
                    settings_path.display(),
                    e
                )
            })?;
            return Ok(Some(contents));
        }
        return Ok(None);
    }

    // Not in portable mode - check app data dir as fallback
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    let settings_path = app_data_dir.join("settings.json");
    if settings_path.exists() {
        let contents = std::fs::read_to_string(&settings_path).map_err(|e| {
            format!(
                "Failed to read settings from '{}': {}",
                settings_path.display(),
                e
            )
        })?;
        return Ok(Some(contents));
    }

    Ok(None)
}

/// Writes settings to the portable settings file.
///
/// Saves the provided JSON string to `{data_dir}/settings.json`, creating
/// the directory if necessary.
#[tauri::command]
pub fn write_portable_settings(
    app: tauri::AppHandle,
    settings_json: String,
) -> Result<(), String> {
    let data_dir = if let Some(portable_dir) = get_portable_data_path() {
        portable_dir
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data directory: {}", e))?
    };

    // Ensure directory exists
    std::fs::create_dir_all(&data_dir).map_err(|e| {
        format!(
            "Failed to create data directory '{}': {}",
            data_dir.display(),
            e
        )
    })?;

    let settings_path = data_dir.join("settings.json");
    std::fs::write(&settings_path, settings_json).map_err(|e| {
        format!(
            "Failed to write settings to '{}': {}",
            settings_path.display(),
            e
        )
    })?;

    Ok(())
}
