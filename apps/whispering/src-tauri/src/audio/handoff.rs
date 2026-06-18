//! In-process handoff of finalized recording PCM.
//!
//! At stop the recorder already holds the exact mono 16 kHz `Vec<f32>` the
//! local model and the Opus encoder consume (`recorder::recorder::finalize`).
//! Recovering that buffer by routing it through the durable WAV (write ->
//! fsync -> read -> Symphonia decode) is pure overhead on the live path: it
//! reconstructs a buffer Rust held in RAM milliseconds earlier. This store
//! keeps the finalized buffer in memory so the next consumer
//! (`transcribe_recording` for local, `encode_recording_for_upload` for
//! cloud) takes it in-process. The WAV is still written, off the critical
//! path, as the durable artifact and the cold / history fallback.
//!
//! It is a best-effort optimization cache, never a source of truth: a miss
//! falls back to decoding the WAV from disk, which is always correct. Because
//! a miss is safe, the store needs no precise lifecycle. It holds only the
//! single most recent stop and self-evicts on the next one, so memory is
//! bounded to one recording even if a stash is never consumed (a recording
//! stopped but never transcribed).

use std::sync::Mutex;

/// Tauri-managed in-process PCM handoff. See module docs. `Default` yields an
/// empty store; register one with `Builder::manage`.
#[derive(Default)]
pub struct PcmHandoff {
    slot: Mutex<Option<Pending>>,
}

struct Pending {
    recording_id: String,
    samples: Vec<f32>,
}

impl PcmHandoff {
    /// Stash the finalized PCM for `recording_id`, evicting any previous
    /// unconsumed entry. The caller keeps a separate copy for the off-path
    /// WAV persist; this one is for the in-process consumer.
    pub fn put(&self, recording_id: String, samples: Vec<f32>) {
        *self.lock() = Some(Pending {
            recording_id,
            samples,
        });
    }

    /// Take the finalized PCM for `recording_id` iff it is the stashed one.
    /// Consume-once: the live path routes each recording to exactly one
    /// consumer (local transcribe XOR cloud encode), so the slot clears on
    /// take. An id mismatch or empty slot returns `None`, and the caller
    /// decodes the WAV from disk instead. A stale entry for a different id is
    /// left in place to be evicted by the next `put`.
    pub fn take(&self, recording_id: &str) -> Option<Vec<f32>> {
        let mut slot = self.lock();
        match slot.as_ref() {
            Some(pending) if pending.recording_id == recording_id => {
                slot.take().map(|pending| pending.samples)
            }
            _ => None,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Pending>> {
        // A poisoned lock only means a prior holder panicked mid-update. The
        // cache is best-effort (a miss falls back to disk), so recover the
        // guard rather than propagate the poison.
        self.slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_then_take_returns_the_samples() {
        let handoff = PcmHandoff::default();
        handoff.put("rec-1".to_string(), vec![0.1, 0.2, 0.3]);
        assert_eq!(handoff.take("rec-1"), Some(vec![0.1, 0.2, 0.3]));
    }

    #[test]
    fn take_consumes_so_a_second_take_misses() {
        let handoff = PcmHandoff::default();
        handoff.put("rec-1".to_string(), vec![1.0]);
        assert_eq!(handoff.take("rec-1"), Some(vec![1.0]));
        // The live path retries through disk; the in-memory slot is spent.
        assert_eq!(handoff.take("rec-1"), None);
    }

    #[test]
    fn take_with_wrong_id_misses_and_leaves_the_entry() {
        let handoff = PcmHandoff::default();
        handoff.put("rec-1".to_string(), vec![1.0]);
        assert_eq!(handoff.take("rec-2"), None);
        // The mismatched take must not have evicted the real entry.
        assert_eq!(handoff.take("rec-1"), Some(vec![1.0]));
    }

    #[test]
    fn put_evicts_a_previous_unconsumed_entry() {
        let handoff = PcmHandoff::default();
        handoff.put("rec-1".to_string(), vec![1.0]);
        handoff.put("rec-2".to_string(), vec![2.0]);
        // rec-1 was never taken; the second put bounds memory to one recording.
        assert_eq!(handoff.take("rec-1"), None);
        assert_eq!(handoff.take("rec-2"), Some(vec![2.0]));
    }
}
