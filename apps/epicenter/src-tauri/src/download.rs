//! Cancelable background transfers.
//!
//! A `DownloadManager` registers a running transfer's `AbortHandle` under a
//! frontend-owned download id, so `cancel_download(id)` can abort the in-flight
//! transfer. An aborted transfer surfaces as an `Err` on the matching call.
//!
//! This module is deliberately transfer-agnostic: it runs any future as a
//! cancelable task (`DownloadManager::run`) and carries the progress payload
//! (`DownloadProgress`). The actual model download lives one layer up in
//! `transcription::catalog::download_model`, which streams a GGUF into the
//! shared Hugging Face cache through `hf-hub`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

/// In-flight download registry. Holds one `AbortHandle` per download id while
/// its transfer task runs; `cancel_download` aborts the task through it. The
/// frontend mints a fresh, unique `download_id` for every download attempt, so
/// an id maps to exactly one transfer for its whole lifetime: `register` can
/// never overwrite a live entry, and `unregister`/`abort` can never touch a
/// different attempt's entry. A plain map is enough.
#[derive(Default)]
pub struct DownloadManager {
    inflight: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl DownloadManager {
    fn register(&self, id: &str, handle: tokio::task::AbortHandle) {
        self.inflight
            .lock()
            .expect("download registry poisoned")
            .insert(id.to_string(), handle);
    }

    /// Drop the entry after the transfer settles. Download ids are unique per
    /// attempt, so this only ever removes its own entry.
    fn unregister(&self, id: &str) {
        self.inflight
            .lock()
            .expect("download registry poisoned")
            .remove(id);
    }

    fn abort(&self, id: &str) {
        if let Some(handle) = self
            .inflight
            .lock()
            .expect("download registry poisoned")
            .remove(id)
        {
            handle.abort();
        }
    }

    /// Run `fut` as a cancelable task registered under `id`: `cancel_download(id)`
    /// aborts it, which drops the future (running any staging-cleanup `Drop`) and
    /// surfaces here as an `Err`. The caller, which knows it requested the cancel,
    /// treats that error as a clean stop. Always unregisters, so a finished or
    /// aborted id is safe to cancel again (a no-op).
    pub(crate) async fn run<T>(
        &self,
        id: &str,
        fut: impl Future<Output = T> + Send + 'static,
    ) -> Result<T, String>
    where
        T: Send + 'static,
    {
        let task = tokio::spawn(fut);
        self.register(id, task.abort_handle());
        let outcome = task.await;
        self.unregister(id);
        outcome.map_err(|join_err| format!("download interrupted: {join_err}"))
    }
}

/// Cumulative download progress for one model: bytes received so far across all
/// of its files, and the grand total to expect. The frontend turns it into a
/// 0-100 percent.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    /// Bytes received so far. `f64` because specta forbids exporting 64-bit
    /// ints to TypeScript; model sizes are far below `f64`'s 2^53 exact-integer
    /// ceiling, so no precision is lost.
    bytes_received: f64,
    /// Grand total bytes for the whole model (sum of the catalog file sizes).
    total_bytes: f64,
}

impl DownloadProgress {
    pub(crate) fn new(bytes_received: f64, total_bytes: f64) -> Self {
        Self {
            bytes_received,
            total_bytes,
        }
    }
}

/// Abort the in-flight download registered under `download_id`, if any. The
/// matching `download_model` call then resolves with an `Err` (and the dropped
/// task leaves a temp file in the HF cache, never a corrupt final). A no-op when
/// nothing is downloading under that id, so it is always safe to call.
#[tauri::command]
#[specta::specta]
pub fn cancel_download(download_id: String, manager: State<'_, DownloadManager>) {
    manager.abort(&download_id);
}
