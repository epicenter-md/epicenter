//! The one Epicenter application-data root, resolved natively.
//!
//! `@epicenter/constants/app-data` is the authority on this path, and the Bun
//! sidecar calls it directly (ADR-0201). Rust resolves it here for the one
//! consumer that cannot be handed the sidecar's answer: the staged-recording
//! blob store in [`crate::recorder::blob`], which writes `<root>/blobs` from
//! Rust. Who eventually tells the recorder where blobs live is an open
//! question; until it is settled this is the second implementation of one path,
//! and the equality is pinned by a test rather than by inspection.
//!
//! The override is part of that equality and not an extra. Rust used to compute
//! the root and pass it to the sidecar in `EPICENTER_DATA_DIR`, which meant an
//! ambient value was overwritten and could not split the two. The sidecar now
//! resolves its own root and honours the variable, so the recorder has to honour
//! it too: otherwise a person who moved their data would have recordings written
//! to one `blobs/` and served from another.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tauri::{AppHandle, Manager, Runtime};

/// The one override for the one root, read by the sidecar, every CLI, and here.
const DATA_ROOT_OVERRIDE: &str = "EPICENTER_DATA_DIR";

/// The root this machine's Epicenter stores everything under.
pub fn epicenter_data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    resolve_data_root(std::env::var_os(DATA_ROOT_OVERRIDE).as_deref(), || {
        app.path()
            .app_data_dir()
            .context("resolve the Tauri application-data directory")
    })
}

/// Apply the override rule to a platform root.
///
/// An empty value counts as unset and a relative one is refused rather than
/// resolved, matching `epicenterDataRoot` exactly: resolving a relative path
/// against the working directory would give a CLI run from two places two roots
/// while the desktop saw a third. The platform root is a closure so a set
/// override never needs it, which is what keeps a Windows machine without
/// `APPDATA` startable by naming the root explicitly.
fn resolve_data_root(
    override_value: Option<&OsStr>,
    platform_root: impl FnOnce() -> Result<PathBuf>,
) -> Result<PathBuf> {
    match override_value {
        Some(value) if !value.is_empty() => {
            let path = Path::new(value);
            if !path.is_absolute() {
                bail!("{DATA_ROOT_OVERRIDE} must be an absolute path, not {value:?}.");
            }
            Ok(path.to_path_buf())
        }
        _ => platform_root(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn unreachable_root() -> Result<PathBuf> {
        panic!("the platform root must not be resolved when the override wins");
    }

    #[test]
    fn an_absolute_override_wins_without_touching_the_platform_root() {
        assert_eq!(
            resolve_data_root(Some(OsStr::new("/tmp/epicenter-test")), unreachable_root).unwrap(),
            PathBuf::from("/tmp/epicenter-test")
        );
    }

    #[test]
    fn an_empty_override_counts_as_unset() {
        assert_eq!(
            resolve_data_root(Some(OsStr::new("")), || Ok(PathBuf::from("/platform"))).unwrap(),
            PathBuf::from("/platform")
        );
        assert_eq!(
            resolve_data_root(None, || Ok(PathBuf::from("/platform"))).unwrap(),
            PathBuf::from("/platform")
        );
    }

    #[test]
    fn a_relative_override_is_refused_rather_than_resolved() {
        let error = resolve_data_root(Some(OsStr::new("tmp/data")), unreachable_root).unwrap_err();
        assert!(error.to_string().contains("absolute"));
    }

    /// The identifier the running desktop is bundled under, read from the file
    /// Tauri itself reads, so this test cannot drift from the build.
    fn bundle_identifier() -> String {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        config["identifier"].as_str().unwrap().to_string()
    }

    /// Ask Bun for `epicenterDataRoot()` on this machine, with the override
    /// removed so the answer is the platform rule rather than an ambient value.
    fn typescript_data_root() -> PathBuf {
        let output = Command::new("bun")
            .arg("-e")
            .arg(concat!(
                "import { epicenterDataRoot } from '@epicenter/constants/app-data';",
                "process.stdout.write(epicenterDataRoot());"
            ))
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/.."))
            .env_remove(DATA_ROOT_OVERRIDE)
            .output()
            .expect(
                "run bun; the Epicenter host is a Bun program and its tests assume the toolchain",
            );
        assert!(
            output.status.success(),
            "bun failed to resolve the data root: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        PathBuf::from(String::from_utf8(output.stdout).unwrap())
    }

    /// The one equality neither side can check by reading the other.
    ///
    /// `@epicenter/constants/app-data` transcribes what Tauri 2.11 and `dirs`
    /// 6.0 do; this runs both implementations on the machine the test is on and
    /// compares the answers. A `dirs` bump, a Tauri change, or an edited
    /// identifier fails here instead of silently splitting a person's data
    /// between a desktop host and a CLI (ADR-0201).
    #[test]
    fn the_native_root_equals_the_typescript_resolver() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = bundle_identifier();
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("build a mock Tauri app for its path resolver");

        let native = resolve_data_root(None, || {
            app.path()
                .app_data_dir()
                .context("resolve the Tauri application-data directory")
        })
        .unwrap();

        assert_eq!(native, typescript_data_root());
    }
}
