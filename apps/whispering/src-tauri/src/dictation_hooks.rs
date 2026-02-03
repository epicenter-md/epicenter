//! Extensible dictation hooks: run custom commands when recording starts/stops.
//!
//! Config: `~/.epicenter/local.json` with `dictation_hooks` list. Status is run
//! only on start; if we muted then we unmute on stop using the stored list.
//! All hook commands run in a blocking thread with a timeout so they cannot
//! hang or break the main process.
//! Logs key events to ~/.epicenter/dictation_hooks.log; set "debug": true on a
//! hook for extra detail (e.g. status output, command stdout/stderr).

use log::{info, warn};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Hooks we ran on_start_dictation for; consumed by stop so we run on_stop_dictation.
static LAST_TOGGLED: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn last_toggled() -> &'static Mutex<Vec<String>> {
    LAST_TOGGLED.get_or_init(|| Mutex::new(Vec::new()))
}

fn epicenter_dir() -> Option<PathBuf> {
    #[cfg(unix)]
    let home = std::env::var_os("HOME");
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    home.map(PathBuf::from).map(|h| h.join(".epicenter"))
}

fn config_path() -> Option<PathBuf> {
    epicenter_dir().map(|d| d.join("local.json"))
}

fn log_file_path() -> Option<PathBuf> {
    epicenter_dir().map(|d| d.join("dictation_hooks.log"))
}

/// Append a line to ~/.epicenter/dictation_hooks.log (ISO timestamp, 3 fractional seconds). Never fails the main flow.
fn log_to_file(line: &str) {
    log_to_file_timed(line, None);
}

/// Like log_to_file but prefix with elapsed ms since session start for timing debug (e.g. "+1234ms").
fn log_to_file_timed(line: &str, elapsed_ms: Option<u128>) {
    let path = match log_file_path() {
        Some(p) => p,
        None => return,
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let prefix = elapsed_ms.map(|ms| format!("+{}ms ", ms)).unwrap_or_default();
    let msg = format!("[{}] {}{}\n", now, prefix, line);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(msg.as_bytes());
    }
}

#[derive(Debug, Deserialize)]
struct LocalConfig {
    dictation_hooks: Option<Vec<DictationHook>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DictationHook {
    pub name: String,
    #[serde(default)]
    pub debug: bool,
    pub status_command: Vec<String>,
    pub json_key: String,
    /// When the status JSON has this value at `json_key`, we run on_start/on_stop.
    /// Can be a boolean or string in JSON (e.g. false or "unmuted").
    #[serde(alias = "do_toggle_key_value")]
    pub do_toggle_when_value: JsonValue,
    pub on_start_dictation: Vec<String>,
    pub on_stop_dictation: Vec<String>,
}

fn read_config() -> Option<LocalConfig> {
    let path = config_path()?;
    let contents = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&contents).ok()
}

const HOOK_CMD_TIMEOUT_SECS: u64 = 15;

fn run_command_sync(args: &[String]) -> Result<(bool, String, String), String> {
    if args.is_empty() {
        return Err("empty command".to_string());
    }
    let output = Command::new(&args[0])
        .args(&args[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to run command: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let ok = output.status.success();
    Ok((ok, stdout, stderr))
}

/// Run a hook command in a blocking thread with timeout so it can't hang the process.
async fn run_command_isolated(args: Vec<String>) -> Result<(bool, String, String), String> {
    let timeout_duration = Duration::from_secs(HOOK_CMD_TIMEOUT_SECS);
    let join = tokio::task::spawn_blocking(move || run_command_sync(&args));
    match tokio::time::timeout(timeout_duration, join).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("hook command task failed: {}", e)),
        Err(_) => Err(format!(
            "hook command timed out after {}s",
            HOOK_CMD_TIMEOUT_SECS
        )),
    }
}

async fn should_toggle_async(hook: &DictationHook, start: Option<&Instant>) -> Result<bool, String> {
    let cmd = hook.status_command.clone();
    let (ok, stdout, stderr) = run_command_isolated(cmd.clone()).await?;
    let elapsed_ms = start.map(|s| s.elapsed().as_millis() as u128);
    log_to_file_timed(&format!("step: hook '{}' status_command done -> ok={}", hook.name, ok), elapsed_ms);
    if hook.debug {
        log_to_file_timed(
            &format!(
                "hook '{}' status_command {:?} -> ok={} stdout={:?} stderr={:?}",
                hook.name, cmd, ok, stdout.trim(), stderr.trim()
            ),
            elapsed_ms,
        );
    }
    if !ok {
        return Ok(false);
    }
    let json: JsonValue = serde_json::from_str(stdout.trim()).map_err(|e| {
        format!(
            "hook '{}': status output is not valid JSON: {}",
            hook.name, e
        )
    })?;
    let obj = json.as_object().ok_or_else(|| {
        format!("hook '{}': status JSON is not an object", hook.name)
    })?;
    let current = obj.get(&hook.json_key).cloned().unwrap_or(JsonValue::Null);
    Ok(current == hook.do_toggle_when_value)
}

/// Run on_start_dictation for each hook whose status matches. Returns names of hooks we toggled.
/// All external commands run isolated with a timeout so they cannot hang or break the process.
#[tauri::command]
pub async fn epicenter_dictation_hooks_start() -> Result<Vec<String>, String> {
    let start = Instant::now();
    log_to_file_timed("epicenter_dictation_hooks_start invoked (first call into backend)", Some(0));

    let config = match read_config() {
        Some(c) => c,
        None => {
            log_to_file_timed("no config or config empty, skipping", Some(start.elapsed().as_millis() as u128));
            return Ok(Vec::new());
        }
    };
    let elapsed_ms = start.elapsed().as_millis() as u128;
    log_to_file_timed(&format!("step: config loaded, {} hooks", config.dictation_hooks.as_ref().map(|h| h.len()).unwrap_or(0)), Some(elapsed_ms));

    let hooks = match config.dictation_hooks {
        Some(h) if !h.is_empty() => h,
        _ => {
            log_to_file_timed("no dictation_hooks in config, skipping", Some(start.elapsed().as_millis() as u128));
            return Ok(Vec::new());
        }
    };

    let mut toggled = Vec::new();
    for hook in hooks {
        log_to_file_timed(&format!("step: hook '{}' status_command start", hook.name), Some(start.elapsed().as_millis() as u128));
        match should_toggle_async(&hook, Some(&start)).await {
            Ok(true) => {
                log_to_file_timed(&format!("hook '{}' status matches, running on_start_dictation", hook.name), Some(start.elapsed().as_millis() as u128));
                info!(
                    "[dictation_hooks] hook '{}' status matches, running on_start_dictation",
                    hook.name
                );
                if hook.on_start_dictation.is_empty() {
                    continue;
                }
                // Record this hook immediately so stop will see it even if the mute command
                // is still running or times out (user may stop before we finish).
                toggled.push(hook.name.clone());
                *last_toggled().lock().expect("last_toggled mutex") = toggled.clone();
                log_to_file_timed(&format!("stored toggled list for stop (before command): {:?}", toggled), Some(start.elapsed().as_millis() as u128));

                log_to_file_timed(&format!("step: hook '{}' on_start_dictation command start", hook.name), Some(start.elapsed().as_millis() as u128));
                let cmd = hook.on_start_dictation.clone();
                match run_command_isolated(cmd.clone()).await {
                    Ok((ok, stdout, stderr)) => {
                        log_to_file_timed(&format!(
                            "hook '{}' on_start_dictation {:?} -> ok={}",
                            hook.name, cmd, ok
                        ), Some(start.elapsed().as_millis() as u128));
                        if hook.debug {
                            log_to_file_timed(&format!("  stdout={:?} stderr={:?}", stdout.trim(), stderr.trim()), Some(start.elapsed().as_millis() as u128));
                        }
                        if !ok {
                            warn!(
                                "[dictation_hooks] hook '{}' on_start_dictation returned non-zero",
                                hook.name
                            );
                        }
                    }
                    Err(e) => {
                        log_to_file_timed(&format!("hook '{}' on_start_dictation {:?} FAILED: {}", hook.name, cmd, e), Some(start.elapsed().as_millis() as u128));
                        warn!("[dictation_hooks] hook '{}' on_start_dictation failed: {}", hook.name, e);
                    }
                }
            }
            Ok(false) => {
                log_to_file_timed(&format!("hook '{}' status did not match, skipping", hook.name), Some(start.elapsed().as_millis() as u128));
            }
            Err(e) => {
                log_to_file_timed(&format!("hook '{}' status check failed: {}", hook.name, e), Some(start.elapsed().as_millis() as u128));
                warn!("[dictation_hooks] hook '{}' status check failed: {}", hook.name, e);
            }
        }
    }
    log_to_file_timed(&format!("epicenter_dictation_hooks_start done, toggled: {:?}", toggled), Some(start.elapsed().as_millis() as u128));
    Ok(toggled)
}

/// Run on_stop_dictation for each hook we toggled at start (uses list stored in backend).
#[tauri::command]
pub async fn epicenter_dictation_hooks_stop() -> Result<(), String> {
    let start = Instant::now();
    log_to_file_timed("epicenter_dictation_hooks_stop invoked (first call into backend)", Some(0));
    let toggled: Vec<String> = std::mem::take(&mut *last_toggled().lock().expect("last_toggled mutex"));
    log_to_file_timed(&format!("toggled list from start: {:?} (empty={})", toggled, toggled.is_empty()), Some(start.elapsed().as_millis() as u128));
    if toggled.is_empty() {
        log_to_file_timed("no toggled hooks, nothing to run for on_stop_dictation", Some(start.elapsed().as_millis() as u128));
        return Ok(());
    }
    info!("[dictation_hooks] running on_stop_dictation for: {:?}", toggled);
    let config = match read_config() {
        Some(c) => c,
        None => {
            log_to_file_timed("stop: no config, cannot run on_stop_dictation", Some(start.elapsed().as_millis() as u128));
            return Ok(());
        }
    };
    let hooks = match config.dictation_hooks {
        Some(h) => h,
        None => {
            log_to_file_timed("stop: no dictation_hooks in config", Some(start.elapsed().as_millis() as u128));
            return Ok(());
        }
    };
    log_to_file_timed("step: config loaded for stop", Some(start.elapsed().as_millis() as u128));
    let by_name: HashMap<_, _> = hooks
        .into_iter()
        .map(|h| (h.name.clone(), h))
        .collect();

    for name in &toggled {
        if let Some(hook) = by_name.get(name) {
            if hook.on_stop_dictation.is_empty() {
                log_to_file_timed(&format!("hook '{}' has empty on_stop_dictation, skipping", name), Some(start.elapsed().as_millis() as u128));
                continue;
            }
            let cmd = hook.on_stop_dictation.clone();
            log_to_file_timed(&format!("step: running on_stop_dictation for hook '{}': {:?}", name, cmd), Some(start.elapsed().as_millis() as u128));
            info!(
                "[dictation_hooks] running on_stop_dictation for hook '{}'",
                name
            );
            match run_command_isolated(cmd.clone()).await {
                Ok((ok, stdout, stderr)) => {
                    log_to_file_timed(&format!("hook '{}' on_stop_dictation {:?} -> ok={}", name, cmd, ok), Some(start.elapsed().as_millis() as u128));
                    if hook.debug {
                        log_to_file_timed(&format!("  stdout={:?} stderr={:?}", stdout.trim(), stderr.trim()), Some(start.elapsed().as_millis() as u128));
                    }
                    if !ok {
                        warn!(
                            "[dictation_hooks] hook '{}' on_stop_dictation returned non-zero",
                            name
                        );
                    }
                }
                Err(e) => {
                    log_to_file_timed(&format!("hook '{}' on_stop_dictation {:?} FAILED: {}", name, cmd, e), Some(start.elapsed().as_millis() as u128));
                    warn!(
                        "[dictation_hooks] hook '{}' on_stop_dictation failed: {}",
                        name, e
                    );
                }
            }
        } else {
            log_to_file_timed(&format!("hook '{}' not found in config, skipping on_stop", name), Some(start.elapsed().as_millis() as u128));
        }
    }
    log_to_file_timed("epicenter_dictation_hooks_stop done", Some(start.elapsed().as_millis() as u128));
    Ok(())
}
