//! Focused OS credential-store backing for the persisted OAuth grant.
//!
//! The webview supplies only the secret value. Rust owns the service and
//! account strings, so this IPC surface cannot become a generic OS credential
//! read/write primitive if webview JavaScript is compromised. The secret is
//! stored in the OS's real credential store (Keychain Services on macOS,
//! Credential Manager on Windows, Secret Service on Linux) via the `keyring`
//! crate. Its default `v1` feature already picks the right native backend per
//! platform, so there is no per-OS Cargo feature to juggle here.
//!
//! `keyring`'s `Entry` calls are blocking OS/D-Bus round-trips (and can block
//! on a locked keychain waiting for the user), so both commands hop onto
//! Tokio's blocking pool via `spawn_blocking` instead of running on an async
//! worker thread.

use keyring::{Entry, Error as KeyringCrateError};
use serde::Serialize;
use thiserror::Error;

const KEYRING_SERVICE: &str = "so.epicenter";
// macOS scopes keychain ACLs to the app's code signature, so an
// ad-hoc-signed dev build touching an entry created by the notarized prod
// build, or the reverse, can trigger a Keychain permission prompt. If that
// bites, suffix this service string per channel, such as `so.epicenter.dev`,
// rather than sharing one entry across signatures.

// Epicenter's Whispering surface stores exactly one secret, so the account is a Rust constant. A
// future second secret, such as the planned vault keyring cache, adds its own
// command pair with its own hardcoded account, not a webview-supplied account
// parameter.
const KEYRING_ACCOUNT: &str = "auth-grant";

/// Structured failure for both commands.
///
/// Only one variant: the frontend adapter (`tauriOnly.keyring` in
/// `tauri.tauri.ts`) does not branch on a finer taxonomy. It logs and treats a
/// read failure as signed-out, and propagates a write failure, exactly like
/// the `localStorage`-backed `PersistedAuthStorage` adapter it replaces. The
/// detail still travels in `message`.
#[derive(Error, Debug, Serialize, specta::Type)]
#[serde(tag = "name")]
pub enum KeyringError {
    #[error("{message}")]
    Failed { message: String },
}

impl KeyringError {
    fn from_crate_error(context: &str, err: KeyringCrateError) -> Self {
        Self::Failed {
            message: format!("{context}: {err}"),
        }
    }

    fn task_panicked(context: &str, join_err: tokio::task::JoinError) -> Self {
        Self::Failed {
            message: format!("{context}: blocking task panicked: {join_err}"),
        }
    }
}

/// Read the stored secret, or `None` when absent.
///
/// `keyring::Error::NoEntry` (nothing stored yet, or a prior delete) is the
/// only variant folded into `Ok(None)`; every other failure (locked keychain,
/// platform failure, bad encoding) surfaces as `Err`.
#[tauri::command]
#[specta::specta]
pub async fn keyring_read() -> Result<Option<String>, KeyringError> {
    tokio::task::spawn_blocking(move || {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(KeyringCrateError::NoEntry) => Ok(None),
            Err(e) => Err(KeyringError::from_crate_error("reading keyring entry", e)),
        }
    })
    .await
    .map_err(|join_err| KeyringError::task_panicked("keyring_read", join_err))?
}

/// Write `value` as the stored secret, or delete the entry when `value` is
/// `None`.
///
/// Deleting an entry that is already absent (`NoEntry`) is treated as
/// success, matching `Storage.removeItem`'s no-throw-if-missing semantics:
/// the TypeScript `PersistedAuthStorage.set(null)` contract relies on a
/// no-op delete being safe to call repeatedly.
#[tauri::command]
#[specta::specta]
pub async fn keyring_write(value: Option<String>) -> Result<(), KeyringError> {
    tokio::task::spawn_blocking(move || {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?;
        match value {
            Some(password) => entry
                .set_password(&password)
                .map_err(|e| KeyringError::from_crate_error("writing keyring entry", e)),
            None => match entry.delete_credential() {
                Ok(()) | Err(KeyringCrateError::NoEntry) => Ok(()),
                Err(e) => Err(KeyringError::from_crate_error("deleting keyring entry", e)),
            },
        }
    })
    .await
    .map_err(|join_err| KeyringError::task_panicked("keyring_write", join_err))?
}
