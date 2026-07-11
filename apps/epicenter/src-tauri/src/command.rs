#[cfg(target_os = "macos")]
use std::process::Command;

/// Open macOS Accessibility settings.
///
/// This is intentionally a fixed command instead of a general command
/// runner. The app only needs this one OS handoff, so the frontend should
/// not receive shell or process execution privileges.
#[tauri::command]
#[specta::specta]
pub async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Deep-link straight to Privacy & Security > Accessibility. This
        // `x-apple.systempreferences:` scheme is honored by System Settings from
        // Ventura through Sequoia; the older `x-apple.systemsettings:` form was
        // not claimed by any app and failed with kLSApplicationNotFoundErr, so
        // the button only ever hit its manual-instructions fallback.
        let status = Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status()
            .map_err(|e| format!("Failed to open accessibility settings: {}", e))?;

        if status.success() {
            return Ok(());
        }

        return Err(format!(
            "Failed to open accessibility settings: exit code {:?}",
            status.code()
        ));
    }

    // Off macOS there is no such pane; the nudge is a no-op, not a failure (the
    // only caller is the macOS Accessibility guide, which never opens elsewhere).
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Show the macOS Accessibility permission prompt.
///
/// macOS never lets an app grant itself Accessibility, so this only surfaces the
/// system prompt (which also adds the app to the Accessibility list, toggled
/// off); the live grant is observed by the Rust tap supervisor, not returned
/// here. Off macOS there is no such prompt, so this does nothing. Pairs with
/// `open_accessibility_settings` the way `request_microphone_permission` does
/// with the microphone privacy page.
#[tauri::command]
#[specta::specta]
pub async fn request_accessibility_permission() {
    #[cfg(target_os = "macos")]
    tauri_plugin_macos_permissions::request_accessibility_permission().await;
}

/// The OS-level microphone authorization, read from the platform privacy store.
///
/// Only an explicit `Denied` gates recording. `Unknown` (no entry in the store,
/// or a platform with no such gate) means "can't tell from here": the caller
/// treats it as available and lets the recorder's stream-open fallback
/// (`recorder::error::classify_cpal`) classify any real denial from the error
/// itself. So this signal can only *add* a pre-record denial; it never newly
/// blocks a setup that was already working.
#[derive(Debug, Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MicrophonePermission {
    Granted,
    Denied,
    Unknown,
}

/// Read the microphone authorization the OS records up front.
///
/// One owner for every platform. macOS answers through
/// `tauri-plugin-macos-permissions` (AVFoundation), which reports a definitive
/// authorized-or-not, so macOS only ever reads `Granted` or `Denied` (a
/// not-yet-determined status reads as `Denied` and is resolved by the prompt in
/// `request_microphone_permission`). Windows reads the CapabilityAccessManager
/// ConsentStore. Every other platform (Linux) returns `Unknown`, where there is
/// no such store and the stream-open fallback stays the sole classifier.
#[tauri::command]
#[specta::specta]
pub async fn get_microphone_permission() -> MicrophonePermission {
    #[cfg(target_os = "macos")]
    {
        if tauri_plugin_macos_permissions::check_microphone_permission().await {
            MicrophonePermission::Granted
        } else {
            MicrophonePermission::Denied
        }
    }
    #[cfg(target_os = "windows")]
    {
        windows_microphone_permission()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        MicrophonePermission::Unknown
    }
}

/// Windows records the microphone privacy choice as an `"Allow"`/`"Deny"` string
/// under CapabilityAccessManager\ConsentStore. Three scopes gate a desktop app:
/// the machine default (HKLM), the per-user default (HKCU), and the "let desktop
/// apps access the microphone" toggle (HKCU\...\NonPackaged). A deny in any one
/// blocks us, so report `Denied` if any is explicitly deny, `Granted` only when
/// all three explicitly allow, and `Unknown` otherwise: the keys are absent on
/// many installs, and a missing entry must not be read as a denial.
#[cfg(target_os = "windows")]
fn windows_microphone_permission() -> MicrophonePermission {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::{RegKey, HKEY};

    const MICROPHONE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    const NON_PACKAGED: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged";

    // `Some(true)` allow, `Some(false)` deny, `None` no readable entry.
    fn access(root: HKEY, path: &str) -> Option<bool> {
        let value: String = RegKey::predef(root)
            .open_subkey(path)
            .ok()?
            .get_value("Value")
            .ok()?;
        match value.to_ascii_lowercase().as_str() {
            "allow" => Some(true),
            "deny" => Some(false),
            _ => None,
        }
    }

    let scopes = [
        access(HKEY_LOCAL_MACHINE, MICROPHONE),
        access(HKEY_CURRENT_USER, MICROPHONE),
        access(HKEY_CURRENT_USER, NON_PACKAGED),
    ];

    if scopes.iter().any(|scope| *scope == Some(false)) {
        MicrophonePermission::Denied
    } else if scopes.iter().all(|scope| *scope == Some(true)) {
        MicrophonePermission::Granted
    } else {
        MicrophonePermission::Unknown
    }
}

/// Elicit a microphone grant the way each platform allows, then let the caller
/// re-read `get_microphone_permission`.
///
/// macOS shows the system permission prompt (its only programmatic grant path).
/// Windows has no programmatic grant for an unpackaged desktop app, so when the
/// consent store reads `Denied` it deep-links the privacy page for the user to
/// toggle; an `Unknown`/`Granted` reading needs no nudge. Other platforms (Linux)
/// have no such affordance and do nothing.
#[tauri::command]
#[specta::specta]
pub async fn request_microphone_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri_plugin_macos_permissions::request_microphone_permission().await
    }
    #[cfg(target_os = "windows")]
    {
        if matches!(
            windows_microphone_permission(),
            MicrophonePermission::Denied
        ) {
            open_windows_microphone_settings()?;
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(())
    }
}

/// Deep-link the Windows microphone privacy page so the user can toggle access.
#[cfg(target_os = "windows")]
fn open_windows_microphone_settings() -> Result<(), String> {
    use std::process::Command;
    // `ms-settings:` URIs are launched by the shell, not run directly; go
    // through `cmd /C start` so the OS resolves the privacy-microphone page.
    Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:privacy-microphone"])
        .spawn()
        .map_err(|e| format!("Failed to open microphone privacy settings: {e}"))?;
    Ok(())
}
