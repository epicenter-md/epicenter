//! Internal OS credential-store backing for the desktop auth cell.
//!
//! Rust owns the service and account strings. Bun sees the opaque serialized
//! value only through the private sidecar protocol, and WebViews never receive
//! a credential-store primitive. The cell is stored in the OS's real credential
//! store through the `keyring` crate.
//!
//! No WebView command exposes this module. Rust reads the cell before Bun boots
//! and writes it only for correlated requests on the private sidecar pipe.

use keyring::{Entry, Error as KeyringCrateError};
use thiserror::Error;

const KEYRING_SERVICE: &str = "so.epicenter";
// macOS scopes keychain ACLs to the app's code signature, so an
// ad-hoc-signed dev build touching an entry created by the notarized prod
// build, or the reverse, can trigger a Keychain permission prompt. If that
// bites, suffix this service string per channel, such as `so.epicenter.dev`,
// rather than sharing one entry across signatures.

// Epicenter stores exactly one desktop auth cell, so the account is a Rust
// constant rather than an input from Bun or a WebView.
const KEYRING_ACCOUNT: &str = "auth-grant";

/// Internal keyring failure with enough context for the host startup log.
#[derive(Error, Debug)]
pub enum KeyringError {
    #[error("{message}")]
    Failed { message: String },
}

pub(crate) fn read_auth_cell() -> Result<Option<String>, KeyringError> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| KeyringError::from_crate_error("opening keyring entry", e))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(KeyringCrateError::NoEntry) => Ok(None),
        Err(e) => Err(KeyringError::from_crate_error("reading keyring entry", e)),
    }
}

pub(crate) fn write_auth_cell(value: Option<String>) -> Result<(), KeyringError> {
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
}

impl KeyringError {
    fn from_crate_error(context: &str, err: KeyringCrateError) -> Self {
        Self::Failed {
            message: format!("{context}: {err}"),
        }
    }
}
