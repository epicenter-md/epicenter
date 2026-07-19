use tauri::{Manager, WebviewWindowBuilder};
use tauri_plugin_log::{Target, TargetKind};

pub mod keyring_storage;

use keyring_storage::{keyring_read, keyring_write, read_serialized_for_boot};

fn auth_bootstrap_script(serialized: Option<String>, error: Option<String>) -> String {
    let serialized = serde_json::to_string(&serialized).expect("serialize auth bootstrap");
    let error = serde_json::to_string(&error).expect("serialize auth bootstrap error");
    format!(
        r#"Object.defineProperty(window, '__EPICENTER_HONEYCRISP_AUTH_BOOTSTRAP__', {{
  value: {{ serialized: {serialized}, error: {error} }},
  enumerable: false,
  configurable: true,
  writable: false,
}});"#
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .target(Target::new(TargetKind::Stdout))
        .target(Target::new(TargetKind::LogDir {
            file_name: Some("honeycrisp".to_string()),
        }))
        .build();

    tauri::Builder::default()
        .plugin(log_plugin)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![keyring_read, keyring_write])
        .setup(|app| {
            // Register the custom scheme at runtime on Windows and Linux.
            // macOS gets the scheme from the app bundle plist.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            // The auth runtime consumes one synchronous credential snapshot at
            // module construction. Build the main WebView only after its native
            // owner has read that snapshot, then inject it at document start.
            // This avoids top-level await and the WebKit module-cycle crash it
            // caused in packaged builds. The read is bounded so a hung
            // credential store cannot leave the launch with zero windows: on
            // timeout the window is still created, the error rides the
            // snapshot, and the app boots signed out with the grant untouched.
            let (serialized, error) = match read_serialized_for_boot() {
                Ok(serialized) => (serialized, None),
                Err(error) => (None, Some(error.to_string())),
            };
            let window = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("missing Honeycrisp main-window configuration")?;
            WebviewWindowBuilder::from_config(app.handle(), window)?
                .initialization_script(auth_bootstrap_script(serialized, error))
                .build()?;

            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .run(tauri::generate_context!())
        .expect("error while running Honeycrisp");
}

#[cfg(test)]
mod tests {
    use super::auth_bootstrap_script;

    #[test]
    fn auth_bootstrap_is_a_safe_document_start_value() {
        let script = auth_bootstrap_script(
            Some("grant </script> \"quoted\"".to_string()),
            Some("locked\nkeychain".to_string()),
        );

        assert!(script.contains("__EPICENTER_HONEYCRISP_AUTH_BOOTSTRAP__"));
        assert!(script.contains(r#"grant </script> \"quoted\""#));
        assert!(script.contains(r#"locked\nkeychain"#));
    }
}
