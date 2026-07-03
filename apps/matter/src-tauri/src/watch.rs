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
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
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

/// Whether a folder is a table: it contains a `matter.json` (ADR-0029). One metadata check,
/// mirroring `isMarked` in the CLI loader (`src/lib/load/fs.ts`). A marker that is absent (or
/// somehow not a regular file) means "not a table."
fn is_marked(dir: &Path) -> bool {
    dir.join("matter.json").is_file()
}

/// The vault's tables as absolute paths, applying the SAME marker rule the CLI loader uses
/// (`src/lib/load/fs.ts` `loadPath`, ADR-0029/0032), so the GUI and the CLI agree on what a
/// path is. A folder is a table XOR a container of tables, never both (ADR-0032):
///
///   - a MARKED root IS a single table (its `.md` files are rows); its subfolders are ignored;
///   - an UNMARKED root is a container, and its immediate marked child folders are the tables,
///     sorted.
///
/// No recursion either way: depth is reached by opening the deeper folder. An unmarked folder is
/// not data (an attachment bundle, junk, or an organizational dir) and is skipped. Hidden
/// directories (`.git`, `.obsidian`) are skipped before the marker is even checked. An unmarked
/// root with no marked children lists NOTHING ("no tables here"), the honest answer in the
/// declared-store model, where the old shape rule would have called the same folder one table.
///
/// Errors only when an UNMARKED root cannot be listed; a marked root is reported without reading
/// its children (its table-ness does not depend on them), so it never fails here. A child that
/// races away mid-scan just does not appear, surfacing on the next re-scan.
fn scan_vault(root: &Path) -> Result<Vec<String>, String> {
    // A marked root IS the table; its subfolders never load as subtables (ADR-0032).
    if is_marked(root) {
        return Ok(vec![root.to_string_lossy().to_string()]);
    }
    // An unmarked root is a container: its marked immediate children are the tables, sorted.
    let mut children = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let path = entry.path();
        if is_marked(&path) {
            children.push(path.to_string_lossy().to_string());
        }
    }
    children.sort();
    Ok(children)
}

/// Watch a VAULT root: stream its table list as a full, sorted snapshot. This is the layer above
/// `watch_folder`: where that watches ONE folder's files, this watches the root NON-recursively for
/// the table set changing, and the JS Vault reacts by composing or disposing a per-folder
/// `watch_folder`. Under the marker rule (ADR-0029/0032) the set changes when a top-level entry appears
/// or disappears: a child directory (a table when the root is an unmarked container) OR the root's
/// own `matter.json` (which flips the root between BEING the single table and being a container of
/// its marked children, ADR-0032). The root's `matter.json` is no longer an inert loose file;
/// re-scanning on any root event already accounts for it.
///
/// Each push is the WHOLE table list, not a precise add/remove delta, and the JS reconciles it
/// against its current set (the same "a full rebuild is a pure function of truth" stance the
/// per-table SQLite mirror takes). A remove event cannot be stat-ed to tell folder from file, so
/// re-listing is both simpler and correct: any debounced change at the root re-scans (ADR-0029/0032).
///
/// Live-detection depth: the watch is non-recursive, so a `matter.json`
/// gained or lost INSIDE an existing child folder does NOT fire here, and a child that is not yet a
/// table has no `watch_folder` of its own to carry it. V1 surfaces such a flip on the next reopen
/// (or an app-initiated refresh, e.g. the "adopt folder" action, which knows it just wrote a
/// marker). Watching one level deeper for `matter.json` only is the future refinement.
#[tauri::command]
pub fn watch_vault(
    path: String,
    channel: Channel<Vec<String>>,
    store: State<WatcherStore>,
) -> Result<u32, String> {
    let dir = std::path::PathBuf::from(&path);
    let root = dir.clone();
    let tx = channel.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| {
            // The events are not parsed: any change at the root reduces to "the table list may have
            // changed, re-scan." A failed scan (root vanished) sends nothing and self-heals on the
            // next event.
            let Ok(_events) = result else { return };
            if let Ok(tables) = scan_vault(&root) {
                let _ = tx.send(tables);
            }
        },
    )
    .map_err(|e| e.to_string())?;

    // Arm BEFORE the seed scan so a change during the scan can't slip through the list-then-watch
    // gap; then send the current table list (always, even a one-table or empty root: both are valid
    // states, not errors).
    debouncer
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    let seed = scan_vault(&dir)?;
    let _ = channel.send(seed);

    let id = store.next.fetch_add(1, Ordering::Relaxed);
    store.watchers.lock().unwrap().insert(id, debouncer);
    Ok(id)
}

/// Stop a vault root watch. Symmetric with `unwatch_folder`; both drop the debouncer the id keys,
/// which stops the OS watch. Named apart so each JS layer reads at its own altitude.
#[tauri::command]
pub fn unwatch_vault(id: u32, store: State<WatcherStore>) {
    store.watchers.lock().unwrap().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh scratch dir for one case (mirrors `mirror.rs`), wiped first so a re-run starts clean.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "matter-watch-test-{}-{}-{:?}",
            std::process::id(),
            name,
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    /// Mark a folder as a table by writing a `matter.json` into it (the `{}` untyped marker).
    fn mark(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("matter.json"), "{}").unwrap();
    }

    // These mirror `fs.test.ts` ("loadPath: a folder is a table XOR a container of tables") so the
    // GUI watcher and the CLI loader are pinned to the same marker rule (ADR-0029/0032) in both
    // languages.

    #[test]
    fn a_marked_folder_with_no_marked_children_is_a_lone_table() {
        let dir = scratch("lone");
        mark(&dir);
        std::fs::write(dir.join("note.md"), "# hi").unwrap();
        assert_eq!(scan_vault(&dir).unwrap(), vec![s(&dir)]);
    }

    #[test]
    fn an_unmarked_folder_yields_its_marked_children_sorted() {
        let dir = scratch("vault");
        mark(&dir.join("pages"));
        mark(&dir.join("adaptations"));
        // The root itself is not marked: it is just a container of tables, not a table.
        assert_eq!(
            scan_vault(&dir).unwrap(),
            vec![s(&dir.join("adaptations")), s(&dir.join("pages"))]
        );
    }

    #[test]
    fn a_marked_folder_is_just_itself_even_with_marked_children() {
        // XOR (ADR-0032): a marked folder IS the table; its subfolders are ignored, even when they
        // are themselves marked. The sharp edge: marking a container hides its child tables.
        let dir = scratch("nest");
        mark(&dir);
        mark(&dir.join("drafts"));
        mark(&dir.join("archive"));
        assert_eq!(scan_vault(&dir).unwrap(), vec![s(&dir)]);
    }

    #[test]
    fn an_unmarked_subfolder_under_a_marked_folder_is_ignored() {
        // An attachment bundle: a marked folder's subfolders are ignored regardless (ADR-0032), so
        // an unmarked `images/` never becomes a table.
        let dir = scratch("attachments");
        mark(&dir);
        std::fs::create_dir_all(dir.join("images")).unwrap();
        std::fs::write(dir.join("images").join("cover.md"), "# img").unwrap();
        assert_eq!(scan_vault(&dir).unwrap(), vec![s(&dir)]);
    }

    #[test]
    fn an_unmarked_folder_with_no_marked_children_lists_nothing() {
        // Not a table, and no marked children: "no tables here," not a single table.
        let dir = scratch("nothing");
        std::fs::write(dir.join("note.md"), "# hi").unwrap();
        std::fs::create_dir_all(dir.join("images")).unwrap();
        assert_eq!(scan_vault(&dir).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn a_hidden_marked_child_of_a_container_is_never_a_table() {
        // The container branch is where the hidden-skip bites: a hidden dir is skipped before the
        // marker is even checked, while a real sibling table still loads.
        let dir = scratch("hidden");
        mark(&dir.join("pages"));
        mark(&dir.join(".git"));
        assert_eq!(scan_vault(&dir).unwrap(), vec![s(&dir.join("pages"))]);
    }

    /// The editable-views loop end to end on the REAL filesystem: a card's status is edited on
    /// disk, the watcher re-observes it, the mirror reprojects, and a query moves the card between
    /// buckets. This is the "drag a kanban card -> status: rewrites -> reproject" path with the
    /// gesture and rendering stripped off, so it runs headless under `cargo test`.
    ///
    /// `scan()` stands in for the live watcher: the watcher seeds and streams exactly the deltas
    /// `scan()` produces (`watch_folder` calls it), so asserting on `scan()` after a disk write is
    /// asserting on what the UI would receive. The only piece NOT covered here is the `notify`
    /// debouncer firing on its own (that stays manual QA). The JS projector (`projectToSqlite`)
    /// is stubbed with representative SQL exactly as the `mirror.rs` tests do; its real output is
    /// covered by the bun projector round-trip test.
    #[test]
    fn disk_edit_reprojects_through_scan_and_mirror() {
        use crate::entry::write_entry;
        use crate::mirror::{query_mirror, reset_mirror, write_mirror};
        use serde_json::json;

        let root = scratch("loop");
        mark(&root); // a real table folder carries the marker
        let path: String = s(&root);
        reset_mirror(path.clone()).unwrap(); // production head-of-chain: makes .matter, empties the db

        // One-column `status` projection. In production matter-core builds this from the parsed
        // rows; Rust never sees columns, so the test supplies the SQL directly.
        let schema = "DROP TABLE IF EXISTS \"loop\";\nCREATE TABLE \"loop\" (\"stem\" TEXT PRIMARY KEY, \"status\" TEXT)";
        let insert = r#"INSERT INTO "loop" ("stem", "status") VALUES (?, ?)"#;

        // The text a saveField edit would write, asserted on disk through the watcher's own `scan()`.
        fn card_text_has_status(root: &std::path::Path, want: &str) {
            let card = scan(root)
                .unwrap()
                .into_iter()
                .find_map(|d| match d {
                    FileDelta::Content { file_name, text } if file_name == "card.md" => Some(text),
                    _ => None,
                })
                .expect("card.md should surface as a Content delta");
            assert!(
                card.contains(&format!("status: {want}")),
                "expected status: {want}, got:\n{card}"
            );
        }

        // 1. Create the card with status: todo, project it, assert it is in the todo bucket.
        write_entry(
            path.clone(),
            "card.md".into(),
            "---\nstatus: todo\n---\n# Card\n".into(),
        )
        .unwrap();
        card_text_has_status(&root, "todo");
        write_mirror(
            path.clone(),
            schema.into(),
            insert.into(),
            vec![vec![json!("card"), json!("todo")]],
        )
        .unwrap();
        let todo = query_mirror(
            path.clone(),
            r#"SELECT "stem" FROM "loop" WHERE "status" = 'todo'"#.into(),
            None,
        )
        .unwrap();
        assert_eq!(todo.rows, vec![vec![json!("card")]]);

        // 2. The drag: saveField rewrites status to done on disk (same write_entry path).
        write_entry(
            path.clone(),
            "card.md".into(),
            "---\nstatus: done\n---\n# Card\n".into(),
        )
        .unwrap();
        card_text_has_status(&root, "done");

        // 3. Reproject this batch: the card leaves todo and lands in done.
        write_mirror(
            path.clone(),
            schema.into(),
            insert.into(),
            vec![vec![json!("card"), json!("done")]],
        )
        .unwrap();
        let todo = query_mirror(
            path.clone(),
            r#"SELECT "stem" FROM "loop" WHERE "status" = 'todo'"#.into(),
            None,
        )
        .unwrap();
        assert_eq!(todo.rows.len(), 0, "card should have left the todo bucket");
        let done = query_mirror(
            path,
            r#"SELECT "stem" FROM "loop" WHERE "status" = 'done'"#.into(),
            None,
        )
        .unwrap();
        assert_eq!(done.rows, vec![vec![json!("card")]]);
    }
}
