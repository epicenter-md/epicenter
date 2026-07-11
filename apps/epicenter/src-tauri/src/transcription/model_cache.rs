use super::catalog::resolve_model_path;
use super::config::{TranscriptionSpec, UnloadPolicy};
use super::error::TranscriptionError;
use log::{debug, info, warn};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Once, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use transcribe_cpp::{
    Backend, Feature, Model, ModelOptions, RunExtension, RunOptions, WhisperRunOptions,
};

/// Resident model metadata. The identity fingerprints the bytes at load time so
/// the cache can notice the file changed underneath a stable path (a delete then
/// re-download of the same coordinate, or an external cache edit). `None`
/// identity never compares equal to a fresh read, so the cache reloads.
/// `transcribe_cpp::Model` is `Arc`-backed and cheap to hold resident; each
/// transcription opens a fresh cheap `Session` from it.
struct CachedModel {
    path: PathBuf,
    disk_identity: Option<DiskIdentity>,
    model: Model,
}

type Cached = Option<CachedModel>;

/// Owns the resident model's lifecycle: the loaded model and the unload-policy
/// clock. The frontend owns transcription settings; this cache owns native
/// mechanism only. They share the struct because they share the lifecycle.
#[derive(Clone)]
pub struct ModelCache {
    /// The currently-resident model and the path it was loaded from. The mutex
    /// is held across `load` and the inference call inside `run_loaded` so
    /// concurrent transcribe calls serialize (one model fits in memory, and
    /// transcribe.cpp 0.x permits one in-flight run per model).
    cached: Arc<Mutex<Cached>>,

    /// Millis since UNIX_EPOCH of the last transcription start or completion.
    /// Atomic so the idle watcher can read it without contending with the
    /// cache mutex during long inference.
    last_activity_ms: Arc<AtomicU64>,

    /// Current unload policy for the idle watcher. The frontend reconciles this
    /// value onto its own channel (`set_unload_policy`), independently of the
    /// per-call transcription spec, so it reaches Rust whether or not a model
    /// is selected.
    unload_policy: Arc<RwLock<UnloadPolicy>>,
}

impl ModelCache {
    pub fn new() -> Self {
        Self {
            cached: Arc::new(Mutex::new(None)),
            last_activity_ms: Arc::new(AtomicU64::new(now_millis())),
            unload_policy: Arc::new(RwLock::new(UnloadPolicy::DEFAULT)),
        }
    }

    // ── Runtime policy ────────────────────────────────────────────────

    /// Reconcile the FE-owned unload policy into the idle clock. The frontend
    /// owns the value and pushes it on every change; Rust owns the clock that
    /// enforces it. It carries no model identity, so it applies whether or not a
    /// model is selected.
    pub fn set_unload_policy(&self, policy: UnloadPolicy) {
        *self
            .unload_policy
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = policy;
    }

    fn current_policy(&self) -> UnloadPolicy {
        *self
            .unload_policy
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ── Transcribe ────────────────────────────────────────────────────

    /// Synchronous inference dispatch. Receives the frontend-owned settings as a
    /// per-call spec, validates the samples, resolves the model id to a cached
    /// GGUF path, then loads (or reuses) and runs transcribe.cpp batch. Called
    /// from a blocking-pool thread.
    pub fn transcribe(
        &self,
        samples: Vec<f32>,
        spec: TranscriptionSpec,
    ) -> Result<String, TranscriptionError> {
        if samples.is_empty() {
            warn!("[Transcription] zero samples, returning empty transcript");
            return Ok(String::new());
        }

        let samples = sanitize_samples(samples);

        info!(
            "[Transcription] starting GGUF transcription: model={} pcm_samples={}",
            spec.model_id,
            samples.len(),
        );

        let model_path = resolve_model_path(&spec.model_id)
            .map_err(|message| TranscriptionError::ConfigError { message })?;
        let inference_started = Instant::now();
        let transcript = self.run_loaded(&spec, model_path, &samples)?;

        info!(
            "[Transcription] GGUF transcription complete: characters={} elapsed_ms={}",
            transcript.len(),
            inference_started.elapsed().as_millis(),
        );
        self.evict_if_immediate();
        Ok(transcript)
    }

    // ── Model cache + eviction ────────────────────────────────────────

    /// Load the model for `spec` into the cache without running inference, so
    /// the next transcribe finds it warm. Idempotent: a no-op when the exact
    /// model is already resident. Called at capture start (manual record / VAD
    /// listen) to overlap the cold load with the user's speech. Shares the one
    /// load path (`ensure_loaded`) with transcribe.
    pub fn prewarm(&self, spec: &TranscriptionSpec) -> Result<(), TranscriptionError> {
        let model_path = resolve_model_path(&spec.model_id)
            .map_err(|message| TranscriptionError::ConfigError { message })?;
        self.touch_activity();
        let _guard = self.ensure_loaded(spec, model_path)?;
        Ok(())
    }

    /// Hold the cache lock across load. If `(path, identity)` matches the cache,
    /// reuse; otherwise drop and load fresh under the same lock. The model loads
    /// lazily here, on the transcription that needs it.
    fn ensure_loaded(
        &self,
        spec: &TranscriptionSpec,
        model_path: PathBuf,
    ) -> Result<MutexGuard<'_, Cached>, TranscriptionError> {
        let mut guard = lock_cached(&self.cached);

        // Fingerprint the bytes on disk now and reuse only when they match what
        // the resident model was loaded from. A delete + re-download of the same
        // coordinate, or an external cache edit, changes the identity even though
        // the path is unchanged, so the stale resident model is dropped and
        // reloaded.
        let current_identity = disk_identity(&model_path);
        let reuse = matches!(
            &*guard,
            Some(cached)
                if cached.path == model_path
                    && current_identity.is_some()
                    && current_identity == cached.disk_identity
        );

        if reuse {
            crate::timing_note!("model.load warm-reuse model={}", spec.model_id);
            return Ok(guard);
        }

        let _ = guard.take();
        let started = Instant::now();
        match load_gguf_model(&model_path) {
            Ok(model) => {
                let elapsed_ms = started.elapsed().as_millis() as u64;
                debug!(
                    "[Transcription] model loaded: {} ({}ms)",
                    model_path.display(),
                    elapsed_ms
                );
                crate::timing_note!("model.load COLD {elapsed_ms}ms model={}", spec.model_id);
                *guard = Some(CachedModel {
                    path: model_path,
                    disk_identity: current_identity,
                    model,
                });
            }
            Err(message) => {
                return Err(TranscriptionError::ModelLoadError { message });
            }
        }

        Ok(guard)
    }

    /// Run one batch transcription on the resident model for `spec`, loading it
    /// first if needed. Holds the cache lock across load and inference.
    fn run_loaded(
        &self,
        spec: &TranscriptionSpec,
        model_path: PathBuf,
        samples: &[f32],
    ) -> Result<String, TranscriptionError> {
        self.touch_activity();
        let guard = self.ensure_loaded(spec, model_path)?;

        let model = &guard.as_ref().expect("cache slot populated above").model;
        let started = Instant::now();
        let result = run_gguf(model, samples, spec);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        crate::timing_note!("model.inference {elapsed_ms}ms model={}", spec.model_id);
        self.touch_activity();
        // An inference failure leaves the model resident so the next call can
        // reuse it (the failure may be a transient FFI or input issue).
        result
    }

    fn touch_activity(&self) {
        self.last_activity_ms.store(now_millis(), Ordering::Relaxed);
    }

    /// Drop the resident model now if the current policy is `Immediately`.
    /// Called at the end of every successful transcription.
    fn evict_if_immediate(&self) {
        if !matches!(self.current_policy(), UnloadPolicy::Immediately) {
            return;
        }
        if let Some(path) = self.try_unload() {
            debug!(
                "[Transcription] unloaded model (immediate): {}",
                path.display()
            );
        }
    }

    /// Drop the resident model if the cache isn't mid-transcription, returning
    /// the path it unloaded (or `None` when busy or already empty). Uses
    /// `try_lock` so it never blocks behind an in-flight run: a busy cache keeps
    /// its model, which the next transcription reloads against its per-call spec
    /// anyway. Both eviction policies (immediate and idle) unload through here,
    /// so the lock discipline lives in one place and each caller logs its reason.
    fn try_unload(&self) -> Option<PathBuf> {
        let mut guard = self.cached.try_lock().ok()?;
        guard.take().map(|cached| cached.path)
    }

    // ── Idle watcher ──────────────────────────────────────────────────

    /// Start the background idle watcher. Spawns one task on the Tauri
    /// async runtime; safe to call once at setup.
    pub fn start_idle_watcher(&self) {
        let cache = self.clone();
        tauri::async_runtime::spawn(async move {
            let tick = Duration::from_secs(10);
            loop {
                tokio::time::sleep(tick).await;
                cache.tick_idle();
            }
        });
    }

    fn tick_idle(&self) {
        let Some(timeout) = idle_timeout_for(self.current_policy()) else {
            return;
        };
        let idle = Duration::from_millis(
            now_millis().saturating_sub(self.last_activity_ms.load(Ordering::Relaxed)),
        );
        if idle < timeout {
            return;
        }
        // A long transcription in progress just postpones eviction to the next
        // tick (try_unload's try_lock) instead of blocking the watcher.
        if let Some(path) = self.try_unload() {
            debug!(
                "[Transcription] unloaded model (idle {}s): {}",
                idle.as_secs(),
                path.display()
            );
        }
    }
}

/// Load a GGUF model through transcribe.cpp, initializing the compute backends
/// once on first use. The backend (Metal / Vulkan / CPU) is chosen per target.
fn load_gguf_model(model_path: &Path) -> Result<Model, String> {
    init_transcribe_cpp_backends();
    let options = ModelOptions {
        backend: default_backend(),
        gpu_device: 0,
    };
    Model::load_with(model_path, &options)
        .map_err(|e| format!("Failed to load GGUF model {}: {}", model_path.display(), e))
}

/// Open a session on the resident model and run one batch transcription. Whisper
/// accepts an `initial_prompt`; the runtime is asked directly via
/// `Feature::InitialPrompt` so a non-prompt model (Parakeet) simply ignores it,
/// independent of the catalog's static capability hint.
fn run_gguf(
    model: &Model,
    samples: &[f32],
    spec: &TranscriptionSpec,
) -> Result<String, TranscriptionError> {
    let mut session = model
        .session()
        .map_err(|e| TranscriptionError::ModelLoadError {
            message: format!("Failed to create transcription session: {e}"),
        })?;

    let accepts_prompt = session.model().supports(Feature::InitialPrompt);
    let family = if accepts_prompt
        && spec
            .initial_prompt
            .as_ref()
            .is_some_and(|prompt| !prompt.is_empty())
    {
        Some(RunExtension::Whisper(WhisperRunOptions {
            initial_prompt: spec.initial_prompt.clone(),
            ..Default::default()
        }))
    } else {
        None
    };
    let run_options = RunOptions {
        language: spec.language.clone(),
        family,
        ..Default::default()
    };

    session
        .run(samples, &run_options)
        .map(|transcript| transcript.text.trim().to_string())
        .map_err(|e| TranscriptionError::TranscriptionError {
            message: e.to_string(),
        })
}

static INIT_TRANSCRIBE_CPP: Once = Once::new();

/// Initialize the transcribe-cpp compute backends exactly once.
///
/// `init_backends_default()` scans the directory of the loaded `libtranscribe`
/// for its dlopen'd ggml modules — exactly our bundle layout on every target
/// (Linux `/usr/lib` on the `$ORIGIN/../lib` rpath; x86_64 Windows the install
/// root beside the exe; a dev build loads from the sys crate's own output dir).
/// A no-op on the static targets (macOS Metal, aarch64 Windows): the backends
/// are compiled in.
fn init_transcribe_cpp_backends() {
    INIT_TRANSCRIBE_CPP.call_once(|| {
        transcribe_cpp::init_logging();
        match transcribe_cpp::init_backends_default() {
            Ok(()) => {
                let devices = transcribe_cpp::devices();
                info!(
                    "transcribe-cpp initialized with {} compute device(s)",
                    devices.len()
                );
            }
            Err(e) => warn!("Failed to initialize transcribe-cpp backends: {}", e),
        }
    });
}

/// The GGU compute backend to request per target. transcribe.cpp appends a CPU
/// fallback, so a GPU-init failure degrades to CPU rather than failing the load.
fn default_backend() -> Backend {
    #[cfg(target_os = "macos")]
    {
        Backend::Metal
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        Backend::Vulkan
    }
    #[cfg(target_os = "linux")]
    {
        Backend::Vulkan
    }
    #[cfg(not(any(
        target_os = "macos",
        all(windows, target_arch = "x86_64"),
        target_os = "linux"
    )))]
    {
        Backend::Cpu
    }
}

/// Replace NaN/Inf with 0.0 and cap length so a malformed sample buffer never
/// reaches the ggml FFI boundary (where a `GGML_ASSERT` would abort the process
/// and bypass any Rust-level recovery). Cheap insurance against the most common
/// abort class.
fn sanitize_samples(mut samples: Vec<f32>) -> Vec<f32> {
    // Cap at one hour of mono 16kHz audio. Beyond this we don't run inference
    // reliably anyway and the FE imposes its own caps; this is a backstop
    // against integer overflow or pathological inputs.
    const MAX_SAMPLES: usize = 16_000 * 60 * 60;
    if samples.len() > MAX_SAMPLES {
        warn!(
            "[Transcription] truncating {} samples to MAX_SAMPLES ({})",
            samples.len(),
            MAX_SAMPLES
        );
        samples.truncate(MAX_SAMPLES);
    }
    for s in samples.iter_mut() {
        if !s.is_finite() {
            *s = 0.0;
        }
    }
    samples
}

fn idle_timeout_for(policy: UnloadPolicy) -> Option<Duration> {
    match policy {
        UnloadPolicy::Never | UnloadPolicy::Immediately => None,
        UnloadPolicy::AfterFiveMinutes => Some(Duration::from_secs(5 * 60)),
        UnloadPolicy::AfterThirtyMinutes => Some(Duration::from_secs(30 * 60)),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lock the cache slot, recovering from poisoning by clearing the cached model
/// so the next caller reloads from scratch instead of reusing corrupted state
/// from a previous panic.
fn lock_cached(cached: &Mutex<Cached>) -> MutexGuard<'_, Cached> {
    cached.lock().unwrap_or_else(|poisoned| {
        warn!(
            "[Transcription] Cache mutex was poisoned from previous panic, clearing state to force reload..."
        );
        let mut recovered = poisoned.into_inner();
        *recovered = None;
        recovered
    })
}

/// Cheap fingerprint of the bytes a resident model was loaded from, used to
/// notice when the file at a stable path changed underneath the cache (a delete
/// + re-download of the same coordinate, or an external cache edit). `len`
/// catches a swap to a different file; `mtime` catches a same-size rewrite.
#[derive(Clone, PartialEq, Eq, Debug)]
struct DiskIdentity {
    len: u64,
    mtime: Option<SystemTime>,
}

/// Read the disk identity of a resolved model path, following symlinks so the
/// identity reflects the bytes transcribe.cpp actually reads (HF cache pointers
/// are symlinks into `blobs/`). Returns `None` when the path cannot be stat'd,
/// which the cache treats as "cannot confirm reuse" and reloads.
fn disk_identity(path: &Path) -> Option<DiskIdentity> {
    let meta = std::fs::metadata(path).ok()?;
    Some(DiskIdentity {
        len: meta.len(),
        mtime: meta.modified().ok(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_timeout_is_none_for_non_timed_policies() {
        assert!(idle_timeout_for(UnloadPolicy::Never).is_none());
        assert!(idle_timeout_for(UnloadPolicy::Immediately).is_none());
    }

    #[test]
    fn idle_timeout_matches_minutes() {
        assert_eq!(
            idle_timeout_for(UnloadPolicy::AfterFiveMinutes),
            Some(Duration::from_secs(300))
        );
        assert_eq!(
            idle_timeout_for(UnloadPolicy::AfterThirtyMinutes),
            Some(Duration::from_secs(1800))
        );
    }

    #[test]
    fn sanitize_replaces_nonfinite_samples() {
        let cleaned = sanitize_samples(vec![1.0, f32::NAN, f32::INFINITY, -0.5, f32::NEG_INFINITY]);
        assert_eq!(cleaned, vec![1.0, 0.0, 0.0, -0.5, 0.0]);
    }

    #[test]
    fn disk_identity_stable_when_unchanged() {
        let dir = std::env::temp_dir().join(format!(
            "epicenter-whispering-id-stable-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.gguf");
        std::fs::write(&path, b"steady").unwrap();

        let a = disk_identity(&path).expect("identity for existing file");
        let b = disk_identity(&path).expect("identity on second read");
        assert_eq!(
            a, b,
            "identity is stable across reads when bytes are unchanged"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disk_identity_changes_on_file_rewrite() {
        let dir = std::env::temp_dir().join(format!(
            "epicenter-whispering-id-file-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.gguf");

        // A swap to a different model: a different size alone changes identity.
        std::fs::write(&path, b"first").unwrap();
        let first = disk_identity(&path).expect("identity");
        std::fs::write(&path, b"second-and-longer").unwrap();
        let second = disk_identity(&path).expect("identity after size change");
        assert_ne!(first, second, "a size change changes identity");

        // A same-size re-download a tick later: equal length, so only mtime can
        // carry the difference. "thirdx-and-longer" matches "second-and-longer".
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&path, b"thirdx-and-longer").unwrap();
        let third = disk_identity(&path).expect("identity after same-size rewrite");
        assert_eq!(
            b"second-and-longer".len(),
            b"thirdx-and-longer".len(),
            "test fixture must be same-size to exercise the mtime path"
        );
        assert_ne!(
            second, third,
            "a same-size rewrite changes identity via mtime"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disk_identity_none_for_missing_path() {
        let path = std::env::temp_dir().join("epicenter-whispering-id-missing-does-not-exist");
        std::fs::remove_file(&path).ok();
        assert!(disk_identity(&path).is_none());
    }
}
