//! Watch a vault folder: stream its markdown + model as self-contained deltas.
//!
//! One command owns the whole live-folder protocol. `watch_folder` arms a
//! `notify` watcher (non-recursive, top level only), THEN scans the folder and
//! pushes its current contents as the first delta batch, then streams a batch
//! per debounced change. Arming before the scan closes the read-then-watch gap.
//!
//! Each delta is self contained: a basename plus the file's observable state
//! (readable text / removed / unreadable), so the frontend never round-trips a
//! separate read. There is no fs-scope to configure: it touches only the
//! absolute path the dialog returned.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

type FolderWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Active watchers keyed by id, kept alive until `unwatch_folder` drops them
/// (dropping the debouncer stops the OS watch).
#[derive(Default)]
pub struct WatcherStore {
    next: AtomicU32,
    watchers: Mutex<HashMap<u32, FolderWatcher>>,
}

/// One file's observable state. The file's basename (top level, non-recursive) is the
/// row identity the frontend keys on, sent as `fileName`. Serialized as a `{ kind, ... }` union.
///
/// This enum is the SINGLE SOURCE OF TRUTH for the IPC payload: `ts-rs` derives the
/// matching TS `FileDelta` into `src/lib/bindings/FileDelta.ts` (run `cargo test`
/// after changing the variants), so the frontend imports it instead of hand-mirroring
/// it. `notify_debouncer_full` and `Channel` carry it; `serde` and `ts-rs` read the
/// same `tag`/`rename_all`, so the wire shape and the generated type stay in lockstep
/// by construction.
#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum FileDelta {
    /// Read as UTF-8 text: the frontend parses it into a row (or its own
    /// "Can't read" bucket on bad YAML / conflict markers).
    Content { file_name: String, text: String },
    /// Gone from disk: the frontend drops it.
    Removed { file_name: String },
    /// Present but not UTF-8 text (binary, permission): the frontend routes it
    /// to "Can't read" rather than silently dropping it.
    Unreadable { file_name: String },
}

/// Only `.md` files and `matter.json` are part of the model; everything else in
/// the folder is ignored (mirrors the non-recursive, flat one-folder-is-a-table
/// shape). The frontend owns no path logic: this filter and the basename are Rust's.
fn is_relevant(name: &str) -> bool {
    name == "matter.json" || name.ends_with(".md")
}

/// Read one entry's current state. `path` is absolute; `file_name` is its basename.
/// A vanished file is `Removed`; a present-but-undecodable file is `Unreadable`,
/// never a hard failure of the surrounding scan.
fn delta_for(file_name: String, path: &Path) -> FileDelta {
    match std::fs::read_to_string(path) {
        Ok(text) => FileDelta::Content { file_name, text },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileDelta::Removed { file_name },
        Err(_) => FileDelta::Unreadable { file_name },
    }
}

/// Scan the folder's current relevant files (the seed batch). Errors only if the
/// directory itself can't be listed; an unreadable individual file becomes an
/// `Unreadable` delta, not a failure.
fn scan(dir: &Path) -> Result<Vec<FileDelta>, String> {
    let mut deltas = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_relevant(&name) {
            deltas.push(delta_for(name, &entry.path()));
        }
    }
    Ok(deltas)
}

#[tauri::command]
pub fn watch_folder(
    path: String,
    channel: Channel<Vec<FileDelta>>,
    store: State<WatcherStore>,
) -> Result<u32, String> {
    let dir = std::path::PathBuf::from(&path);
    let tx = channel.clone();
    // Coalesce an external write burst (agent / git / editor) into one batch. Writes
    // land atomically (entry.rs renames over the file), so no debounce value risks a
    // torn read; this is purely how fast EXTERNAL edits surface. The app's own edits do
    // not wait on this path (the write applies its own result), so 100ms favors latency
    // over deeper coalescing without the app ever feeling it.
    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            // Dedup by basename within the tick; read each changed file once.
            let mut changed: HashMap<String, std::path::PathBuf> = HashMap::new();
            for event in events {
                for p in event.paths.iter() {
                    let Some(name) = p.file_name().map(|s| s.to_string_lossy().to_string()) else {
                        continue;
                    };
                    if is_relevant(&name) {
                        changed.insert(name, p.clone());
                    }
                }
            }
            if changed.is_empty() {
                return;
            }
            let deltas: Vec<FileDelta> = changed
                .into_iter()
                .map(|(name, p)| delta_for(name, &p))
                .collect();
            let _ = tx.send(deltas);
        },
    )
    .map_err(|e| e.to_string())?;

    // Arm the watcher BEFORE scanning so a change during the scan can't slip
    // through the read-then-watch gap; then push the current contents as the
    // first batch (the seed). Dropping the debouncer on any early return stops
    // the OS watch, so a failed scan never leaks a watcher.
    debouncer
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    let seed = scan(&dir)?;
    if !seed.is_empty() {
        let _ = channel.send(seed);
    }

    let id = store.next.fetch_add(1, Ordering::Relaxed);
    store.watchers.lock().unwrap().insert(id, debouncer);
    Ok(id)
}

#[tauri::command]
pub fn unwatch_folder(id: u32, store: State<WatcherStore>) {
    store.watchers.lock().unwrap().remove(&id);
}
