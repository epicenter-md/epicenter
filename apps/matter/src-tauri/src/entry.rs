//! Atomic byte IO for one vault entry: the write half of the live-folder loop.
//!
//! The JS serializes the markdown (frontmatter re-emitted canonically through
//! eemeli `yaml`'s `stringify`, body verbatim); Rust only moves bytes and never
//! learns what a column or schema is, the same faithful-byte-streamer role
//! `watch.rs` plays for reads.
//!
//! `read_entry` hands the JS the freshest on-disk text so an edit is applied to
//! the current bytes (not a stale parse). `write_entry` writes ATOMICALLY (a
//! sibling temp file, then rename over the destination): `rename(2)` within a
//! directory is atomic on POSIX and Windows, so the folder watcher sees one
//! whole-file change and never a half-written or truncated read. The written
//! entry flows back through the watcher as a `Content` delta (the echo), which is
//! how the projection learns the write landed; there is no second write path into
//! the model.

use std::path::{Path, PathBuf};

/// Read one entry's current text. `None` when it does not exist yet (so a write
/// to a new file starts from an empty document); an `Err` only for a real IO or
/// decoding failure.
#[tauri::command]
pub fn read_entry(path: String, file_name: String) -> Result<Option<String>, String> {
    let file = Path::new(&path).join(&file_name);
    match std::fs::read_to_string(&file) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write one entry atomically. The temp file is a sibling (same directory, so the
/// rename is atomic rather than a cross-device copy) and hidden + non-`.md`, so
/// the watcher's relevance filter ignores its create event; only the rename onto
/// the `.md` destination surfaces as a delta. A failed rename cleans up the temp.
#[tauri::command]
pub fn write_entry(path: String, file_name: String, content: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    let dest = dir.join(&file_name);
    let tmp = dir.join(format!(".{file_name}.tmp"));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch dir under the OS temp dir (no external test-tmp crate).
    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "matter-entry-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_missing_is_none_not_error() {
        let dir = scratch();
        let got = read_entry(dir.to_string_lossy().into(), "nope.md".into()).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn write_then_read_round_trips_and_leaves_no_temp() {
        let dir = scratch();
        let path: String = dir.to_string_lossy().into();
        let body = "---\ntitle: Hi\n---\n# Body\n";

        write_entry(path.clone(), "post.md".into(), body.into()).unwrap();

        assert_eq!(
            read_entry(path.clone(), "post.md".into()).unwrap(),
            Some(body.into())
        );
        // The atomic temp must not survive a successful write (and being non-`.md`,
        // it would never have surfaced as a watcher delta anyway).
        assert!(!dir.join(".post.md.tmp").exists());
    }

    #[test]
    fn write_overwrites_in_place() {
        let dir = scratch();
        let path: String = dir.to_string_lossy().into();
        write_entry(path.clone(), "p.md".into(), "first".into()).unwrap();
        write_entry(path.clone(), "p.md".into(), "second".into()).unwrap();
        assert_eq!(
            read_entry(path, "p.md".into()).unwrap(),
            Some("second".into())
        );
    }
}
