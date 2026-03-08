//! Lists system sound files for use in sound customization (desktop only).
//! Paths are platform-specific: macOS /System/Library/Sounds, Windows C:\Windows\Media, etc.

use std::path::Path;

use log::{info, warn};

const SOUND_EXTENSIONS: &[&str] = &["aiff", "aif", "wav", "wave", "mp3", "ogg", "caf"];

fn is_sound_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            let ext_lower = ext.to_lowercase();
            SOUND_EXTENSIONS.contains(&ext_lower.as_str())
        })
        .unwrap_or(false)
}

#[derive(serde::Serialize)]
pub struct SystemSoundEntry {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub async fn list_system_sounds() -> Result<Vec<SystemSoundEntry>, String> {
    let dir = system_sounds_dir().map_err(|e| {
        warn!("[sound] system_sounds_dir failed: {}", e);
        e
    })?;
    info!("[sound] listing OS sounds from {}", dir.display());
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&dir).map_err(|e| {
        let msg = format!("Failed to read sounds dir: {}", e);
        warn!("[sound] {}", msg);
        msg
    })?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_file() && is_sound_file(&path) {
            let path_str = path.to_string_lossy().into_owned();
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("sound");
            let id = format!("os:{}", stem);
            entries.push(SystemSoundEntry {
                id,
                name: stem.to_string(),
                path: path_str,
            });
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    info!("[sound] list_system_sounds found {} OS sounds", entries.len());
    Ok(entries)
}

fn system_sounds_dir() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(Path::new("/System/Library/Sounds").to_path_buf())
    }

    #[cfg(target_os = "windows")]
    {
        let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        Ok(Path::new(&sys_root).join("Media"))
    }

    #[cfg(target_os = "linux")]
    {
        // Prefer freedesktop sound theme; fallback to common paths
        let candidates = [
            "/usr/share/sounds/freedesktop/stereo",
            "/usr/share/sounds",
        ];
        for p in &candidates {
            let path = Path::new(p);
            if path.is_dir() {
                return Ok(path.to_path_buf());
            }
        }
        Ok(Path::new("/usr/share/sounds").to_path_buf())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("System sounds are not supported on this platform".to_string())
    }
}
