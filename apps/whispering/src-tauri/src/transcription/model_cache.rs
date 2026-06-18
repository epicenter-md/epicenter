use super::config::{Engine as EngineKind, TranscriptionSpec, UnloadPolicy};
use super::error::TranscriptionError;
use super::events::{LocalModelState, ModelStateEvent, ModelStatus, UnloadReason};
use log::{debug, info, warn};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use transcribe_rs::onnx::moonshine::{MoonshineModel, MoonshineVariant};
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity};
use transcribe_rs::onnx::Quantization;
use transcribe_rs::whisper_cpp::{WhisperEngine, WhisperInferenceParams};
use transcribe_rs::{SpeechModel, TranscribeOptions};

/// Resident engine variants. Dropping any variant releases the model
/// resources held by the inner type.
enum Engine {
    Whisper(WhisperEngine),
    Parakeet(ParakeetModel),
    Moonshine(MoonshineModel),
}

/// Resident engine metadata. The identity fingerprints the bytes at load time
/// so the cache can notice the file changed underneath a stable path (a delete
/// then re-download under the same name, or an external edit of the
/// user-editable models folder). `None` identity means bytes could not be stat'd
/// at load time, which never compares equal to a fresh read, so the cache
/// reloads. `engine_kind` and `model_name` let `snapshot()` report what is
/// resident now that no ambient config holds that identity.
struct CachedEngine {
    path: PathBuf,
    disk_identity: Option<DiskIdentity>,
    engine_kind: EngineKind,
    model_name: String,
    engine: Engine,
}

type Cached = Option<CachedEngine>;

/// Owns the resident engine's lifecycle and the state observers see while it
/// runs. The frontend owns transcription settings; this cache owns native
/// mechanism only: the loaded engine, the unload-policy clock, the status
/// snapshot, and lifecycle event emission. They share the struct because they
/// share the lifecycle.
#[derive(Clone)]
pub struct ModelCache {
    /// The currently-resident engine and the path it was loaded from. The
    /// mutex is held across `load` and the user closure inside `with_engine`
    /// so concurrent transcribe calls serialize (one engine fits in memory).
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

    /// Status field readable without the cache mutex. Mutated by load,
    /// inference, and eviction paths; never held across a long operation.
    /// The cache mutex stays held across inference, but `status` does not, so
    /// observers reading status alone (the lifecycle events, `read_status`)
    /// never block on it. `snapshot()` still takes the cache mutex for the
    /// resident model's identity, so it can wait behind an in-flight load or
    /// inference; the status read itself does not.
    status: Arc<RwLock<ModelStatus>>,

    /// Handle used for `Emitter::emit` on the lifecycle event channel.
    /// Constructed once in `setup` and cloned cheaply through `Clone` on
    /// the cache.
    app: AppHandle,
}

impl ModelCache {
    pub fn new(app: AppHandle) -> Self {
        Self {
            cached: Arc::new(Mutex::new(None)),
            last_activity_ms: Arc::new(AtomicU64::new(now_millis())),
            unload_policy: Arc::new(RwLock::new(UnloadPolicy::DEFAULT)),
            status: Arc::new(RwLock::new(ModelStatus::Idle)),
            app,
        }
    }

    // ── Runtime policy ────────────────────────────────────────────────

    /// Reconcile the FE-owned unload policy into the idle clock. The frontend
    /// owns the value and pushes it on every change; Rust owns the clock that
    /// enforces it. Unlike the old ambient config, this carries no model
    /// identity, so it applies whether or not a model is selected.
    pub fn set_unload_policy(&self, policy: UnloadPolicy) {
        *self
            .unload_policy
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = policy;
    }

    /// Resolve the spec's model name to the absolute path inside the
    /// engine's models directory. The name must be a single folder entry
    /// (no separators, no traversal), which makes containment structural:
    /// the result is always `{app_data}/models/{engine}/{name}` with no
    /// canonicalize-and-contain check. Symlinked entries are deliberately
    /// honored; the link lives in the folder even when its target does not,
    /// and the engine loaders follow links natively.
    fn model_path_for(&self, spec: &TranscriptionSpec) -> Result<PathBuf, String> {
        let name = spec.model_name.as_str();
        if name.is_empty() {
            return Err("No local model selected. Choose a model in settings.".to_string());
        }
        if !is_contained_entry_name(name) {
            return Err(format!(
                "Model name must be a single models-folder entry, got: {}",
                name
            ));
        }
        let path = engine_models_path(&self.app, spec.engine)?.join(name);
        if !path.exists() {
            return Err(format!(
                "The model \"{}\" is no longer in the models folder. Download it again or add it back, then select it in settings.",
                name
            ));
        }
        Ok(path)
    }

    fn read_status(&self) -> ModelStatus {
        self.status
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    fn current_policy(&self) -> UnloadPolicy {
        *self
            .unload_policy
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ── Snapshot ──────────────────────────────────────────────────────

    /// Read-only view of the resident model and status. New windows call this
    /// on mount to catch up to current state without waiting for the next
    /// event. Reports identity from the resident engine (if any), since the
    /// per-call spec is no longer retained between transcriptions.
    pub fn snapshot(&self) -> LocalModelState {
        let status = self.read_status();
        let cached = lock_cached(&self.cached);
        LocalModelState {
            engine: cached.as_ref().map(|cached| cached.engine_kind),
            model_name: cached.as_ref().map(|cached| cached.model_name.clone()),
            status,
        }
    }

    fn set_status(&self, status: ModelStatus) {
        match self.status.write() {
            Ok(mut g) => *g = status,
            Err(poisoned) => *poisoned.into_inner() = status,
        }
    }

    // ── Transcribe ────────────────────────────────────────────────────

    /// Synchronous inference dispatch. Receives the frontend-owned settings as a
    /// per-call spec, validates the samples, then routes to the engine-specific
    /// path. Called from a blocking-pool thread.
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
            "[Transcription] starting {:?} transcription: pcm_samples={}",
            spec.engine,
            samples.len(),
        );

        let model_path = self
            .model_path_for(&spec)
            .map_err(|message| TranscriptionError::ConfigError { message })?;
        let inference_started = std::time::Instant::now();
        let transcript = match spec.engine {
            EngineKind::Whispercpp => {
                let mut params = WhisperInferenceParams::default();
                params.language = spec.language.clone();
                params.initial_prompt = spec.initial_prompt.clone();
                params.print_special = false;
                params.print_progress = false;
                params.print_realtime = false;
                params.print_timestamps = false;
                params.suppress_blank = true;
                params.suppress_non_speech_tokens = true;
                params.no_speech_thold = 0.2;

                self.with_whisper(&spec, model_path, |engine| {
                    let result = engine
                        .transcribe_with(&samples, &params)
                        .map_err(transcription_err)?;
                    Ok(result.text.trim().to_string())
                })?
            }
            EngineKind::Parakeet => {
                let params = ParakeetParams {
                    timestamp_granularity: Some(TimestampGranularity::Segment),
                    ..Default::default()
                };
                self.with_parakeet(&spec, model_path, |engine| {
                    let result = engine
                        .transcribe_with(&samples, &params)
                        .map_err(transcription_err)?;
                    Ok(result.text.trim().to_string())
                })?
            }
            EngineKind::Moonshine => {
                let variant = parse_moonshine_variant(&spec.model_name)?;
                self.with_moonshine(&spec, model_path, variant, |engine| {
                    let result = engine
                        .transcribe(&samples, &TranscribeOptions::default())
                        .map_err(transcription_err)?;
                    Ok(result.text.trim().to_string())
                })?
            }
        };

        info!(
            "[Transcription] {:?} transcription complete: characters={} elapsed_ms={}",
            spec.engine,
            transcript.len(),
            inference_started.elapsed().as_millis(),
        );
        self.evict_if_immediate();
        Ok(transcript)
    }

    // ── Engine cache + eviction ───────────────────────────────────────

    fn with_whisper<T>(
        &self,
        spec: &TranscriptionSpec,
        model_path: PathBuf,
        f: impl FnOnce(&mut WhisperEngine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            spec,
            model_path,
            |e| matches!(e, Engine::Whisper(_)),
            |path| {
                WhisperEngine::load(path)
                    .map(Engine::Whisper)
                    .map_err(|e| format!("Failed to load Whisper model: {}", e))
            },
            |engine| match engine {
                Engine::Whisper(e) => f(e),
                _ => unreachable!("can_reuse guarantees Whisper variant"),
            },
        )
    }

    fn with_parakeet<T>(
        &self,
        spec: &TranscriptionSpec,
        model_path: PathBuf,
        f: impl FnOnce(&mut ParakeetModel) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            spec,
            model_path,
            |e| matches!(e, Engine::Parakeet(_)),
            |path| {
                ParakeetModel::load(path, &Quantization::Int8)
                    .map(Engine::Parakeet)
                    .map_err(|e| format!("Failed to load Parakeet model: {}", e))
            },
            |engine| match engine {
                Engine::Parakeet(e) => f(e),
                _ => unreachable!("can_reuse guarantees Parakeet variant"),
            },
        )
    }

    fn with_moonshine<T>(
        &self,
        spec: &TranscriptionSpec,
        model_path: PathBuf,
        variant: MoonshineVariant,
        f: impl FnOnce(&mut MoonshineModel) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            spec,
            model_path,
            |e| matches!(e, Engine::Moonshine(_)),
            |path| {
                MoonshineModel::load(path, variant, &Quantization::default())
                    .map(Engine::Moonshine)
                    .map_err(|e| format!("Failed to load Moonshine model: {}", e))
            },
            |engine| match engine {
                Engine::Moonshine(e) => f(e),
                _ => unreachable!("can_reuse guarantees Moonshine variant"),
            },
        )
    }

    /// Hold the cache lock across load. If `(path, identity, engine kind)`
    /// matches the cache, reuse; otherwise drop and load fresh under the same
    /// lock. The model loads lazily here, on the transcription that needs it.
    ///
    /// Holding the cache lock across `emit` is safe: Tauri's emit is sync
    /// and FE handlers run on the JS event loop, so no Rust caller can
    /// re-enter and contend on this mutex.
    fn ensure_loaded(
        &self,
        spec: &TranscriptionSpec,
        model_path: PathBuf,
        can_reuse: impl Fn(&Engine) -> bool,
        load: impl FnOnce(&Path) -> Result<Engine, String>,
    ) -> Result<MutexGuard<'_, Cached>, TranscriptionError> {
        let mut guard = lock_cached(&self.cached);

        // Fingerprint the bytes on disk now and reuse only when they match what
        // the resident engine was loaded from. A delete + re-download under the
        // same name, or an external edit, changes the identity even though the
        // path is unchanged, so the stale resident model is dropped and reloaded.
        let current_identity = disk_identity(&model_path);
        let reuse = matches!(
            &*guard,
            Some(cached)
                if cached.path == model_path
                    && can_reuse(&cached.engine)
                    && current_identity.is_some()
                    && current_identity == cached.disk_identity
        );

        if reuse {
            // The falsification benchmark turns on "is the model already
            // resident?". A warm reuse means the cold-load cost (PR 2's target)
            // was zero for this transcription.
            crate::timing_note!("model.load warm-reuse engine={:?}", spec.engine);
        }

        if !reuse {
            let _ = guard.take();
            self.publish(spec, ModelStatus::Loading, |state| {
                ModelStateEvent::LoadingStarted { state }
            });
            let started = Instant::now();
            match load(&model_path) {
                Ok(engine) => {
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    debug!(
                        "[Transcription] model loaded: {} ({}ms)",
                        model_path.display(),
                        elapsed_ms
                    );
                    // The single largest removable number for short clips; PR 2
                    // (prewarm) decides whether to hide it under the user's
                    // speech. Surface it on the unified timing target too.
                    crate::timing_note!("model.load COLD {elapsed_ms}ms engine={:?}", spec.engine);
                    *guard = Some(CachedEngine {
                        path: model_path,
                        disk_identity: current_identity,
                        engine_kind: spec.engine,
                        model_name: spec.model_name.clone(),
                        engine,
                    });
                    self.publish(spec, ModelStatus::Ready, |state| {
                        ModelStateEvent::LoadingCompleted { state, elapsed_ms }
                    });
                }
                Err(message) => {
                    self.publish(
                        spec,
                        ModelStatus::Error {
                            message: message.clone(),
                        },
                        |state| ModelStateEvent::LoadingFailed {
                            state,
                            error: message.clone(),
                        },
                    );
                    return Err(TranscriptionError::ModelLoadError { message });
                }
            }
        }

        Ok(guard)
    }

    /// Hold the cache lock across load and use, emitting semantic inference
    /// events around the user closure.
    fn with_engine<T>(
        &self,
        spec: &TranscriptionSpec,
        model_path: PathBuf,
        can_reuse: impl Fn(&Engine) -> bool,
        load: impl FnOnce(&Path) -> Result<Engine, String>,
        use_engine: impl FnOnce(&mut Engine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.touch_activity();
        let mut guard = self.ensure_loaded(spec, model_path, can_reuse, load)?;

        let engine = &mut guard.as_mut().expect("cache slot populated above").engine;
        self.publish(spec, ModelStatus::Inferring, |state| {
            ModelStateEvent::InferenceStarted { state }
        });
        let started = Instant::now();
        let result = use_engine(engine);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        crate::timing_note!("model.inference {elapsed_ms}ms engine={:?}", spec.engine);
        self.touch_activity();
        match &result {
            Ok(_) => {
                self.publish(spec, ModelStatus::Ready, |state| {
                    ModelStateEvent::InferenceCompleted { state, elapsed_ms }
                });
            }
            Err(e) => {
                // Don't clear the cache on inference failure: the engine is
                // still loaded and the next call may succeed (transient FFI
                // or input issue). The status reflects the last result; a
                // successful next call flips it back to Ready.
                let message = e.to_string();
                self.publish(
                    spec,
                    ModelStatus::Error {
                        message: message.clone(),
                    },
                    |state| ModelStateEvent::InferenceFailed {
                        state,
                        error: message,
                    },
                );
            }
        }
        result
    }

    fn touch_activity(&self) {
        self.last_activity_ms.store(now_millis(), Ordering::Relaxed);
    }

    /// Drop the resident model now if the current policy is `Immediately`.
    /// Called at the end of every successful transcription.
    fn evict_if_immediate(&self) {
        if matches!(self.current_policy(), UnloadPolicy::Immediately) {
            self.evict(UnloadReason::Immediate);
        }
    }

    /// Drop the resident model and emit an `Unloaded` event with the given
    /// reason, leaving status `Idle`. Uses `try_lock` so it never blocks behind
    /// an in-flight transcription: a busy cache keeps its model, which the next
    /// transcription reloads against its per-call spec anyway. A no-op when the
    /// cache is already empty.
    fn evict(&self, reason: UnloadReason) {
        let Ok(mut guard) = self.cached.try_lock() else {
            return;
        };
        if let Some(cached) = guard.take() {
            debug!(
                "[Transcription] unloaded model ({:?}): {}",
                reason,
                cached.path.display()
            );
            // Drop the guard before emitting so emit handlers cannot deadlock
            // on the cache lock (they should not lock it anyway, but defensive
            // ordering is cheap).
            drop(guard);
            self.set_status(ModelStatus::Idle);
            let state = state_for_model(cached.engine_kind, cached.model_name, ModelStatus::Idle);
            self.emit(ModelStateEvent::Unloaded { state, reason });
        }
    }

    // ── Idle watcher ──────────────────────────────────────────────────

    /// Start the background idle watcher. Spawns one task on the Tauri
    /// async runtime; safe to call once at setup.
    pub fn start_idle_watcher(&self) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let tick = Duration::from_secs(10);
            loop {
                tokio::time::sleep(tick).await;
                this.tick_idle();
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
        // try_lock so a long transcription in progress just postpones eviction
        // to the next tick instead of blocking the watcher.
        let Ok(mut guard) = self.cached.try_lock() else {
            return;
        };
        if let Some(cached) = guard.take() {
            let idle_secs = idle.as_secs();
            debug!(
                "[Transcription] unloaded model (idle {}s): {}",
                idle_secs,
                cached.path.display()
            );
            drop(guard);
            self.set_status(ModelStatus::Idle);
            self.emit(ModelStateEvent::Unloaded {
                state: state_for_model(cached.engine_kind, cached.model_name, ModelStatus::Idle),
                reason: UnloadReason::Idle { idle_secs },
            });
        }
    }

    // ── Event emission ────────────────────────────────────────────────

    fn emit(&self, event: ModelStateEvent) {
        if let Err(err) = event.emit(&self.app) {
            warn!("[Transcription] failed to emit model-state event: {}", err);
        }
    }

    /// Set the resident status and emit the matching lifecycle event built
    /// from the current per-call spec and that status.
    fn publish(
        &self,
        spec: &TranscriptionSpec,
        status: ModelStatus,
        build_event: impl FnOnce(LocalModelState) -> ModelStateEvent,
    ) {
        self.set_status(status.clone());
        self.emit(build_event(state_for_spec(spec, status)));
    }
}

/// Build a `LocalModelState` from a per-call spec and status.
fn state_for_spec(spec: &TranscriptionSpec, status: ModelStatus) -> LocalModelState {
    state_for_model(spec.engine, spec.model_name.clone(), status)
}

fn state_for_model(engine: EngineKind, model_name: String, status: ModelStatus) -> LocalModelState {
    LocalModelState {
        engine: Some(engine),
        model_name: Some(model_name),
        status,
    }
}

/// Replace NaN/Inf with 0.0 and cap length so a malformed sample buffer
/// never reaches whisper.cpp's FFI boundary (where a `GGML_ASSERT` would
/// abort the process and bypass any Rust-level recovery). Cheap insurance
/// against the most common abort class.
fn sanitize_samples(mut samples: Vec<f32>) -> Vec<f32> {
    // Cap at one hour of mono 16kHz audio. Beyond this we don't run
    // inference reliably anyway and the FE imposes its own caps; this
    // is a backstop against integer overflow or pathological inputs.
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

/// Directory under `models/` for each engine. A durable on-disk contract: the
/// folder names are stable (which is why `whispercpp` maps to `whisper`).
/// Private; the only caller is `engine_models_path` in this module.
fn engine_models_dir(engine: EngineKind) -> &'static str {
    match engine {
        EngineKind::Whispercpp => "whisper",
        EngineKind::Parakeet => "parakeet",
        EngineKind::Moonshine => "moonshine",
    }
}

/// Absolute path to an engine's models folder, `{app_data}/models/{engine}`.
/// The one place that joins the appdata root onto the engine folder name, so
/// the loader (`model_path_for`), the link importer, and the webview-facing
/// folder surface (`model_folder.rs`) all resolve the same directory.
pub(crate) fn engine_models_path(app: &AppHandle, engine: EngineKind) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data directory: {}", e))?
        .join("models")
        .join(engine_models_dir(engine)))
}

/// Whether `name` stays within a single models-folder entry: no path
/// separators and no traversal component, so joining it onto the folder can
/// never escape it. The containment rule shared by the loader's
/// `model_path_for` and import-time `validate_entry_name`. Emptiness is left to
/// callers, which treat it differently (no selection vs. a malformed pick).
pub(crate) fn is_contained_entry_name(name: &str) -> bool {
    !name.contains('/') && !name.contains('\\') && name != "." && name != ".."
}

/// `pub(crate)` so the link-import path enforces the same naming rule the
/// Moonshine loader relies on (the variant is read from the entry name, not
/// the files), keeping one source of truth for the convention.
pub(crate) fn parse_moonshine_variant(
    model_name: &str,
) -> Result<MoonshineVariant, TranscriptionError> {
    // Naming convention: moonshine-{variant}-{lang}. Match on the variant
    // segment between the first and last hyphen-bounded fields.
    if model_name.starts_with("moonshine-tiny-") || model_name == "moonshine-tiny" {
        Ok(MoonshineVariant::Tiny)
    } else if model_name.starts_with("moonshine-base-") || model_name == "moonshine-base" {
        Ok(MoonshineVariant::Base)
    } else {
        Err(TranscriptionError::ConfigError {
            message: format!(
                "Moonshine model directories must be named moonshine-{{tiny|base}}-{{lang}}: got {}",
                model_name
            ),
        })
    }
}

fn transcription_err(e: impl std::fmt::Display) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: e.to_string(),
    }
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

/// Lock the cache slot, recovering from poisoning by clearing the cached
/// (path, engine) so the next caller reloads from scratch instead of reusing
/// corrupted state from a previous panic.
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
/// notice when the file or directory at a stable path changed underneath the
/// cache (a delete + re-download under the same name, or an external edit of
/// the user-editable models folder). `len` catches a swap to a different model;
/// `mtime` catches a same-size rewrite.
#[derive(Clone, PartialEq, Eq, Debug)]
struct DiskIdentity {
    len: u64,
    mtime: Option<SystemTime>,
}

/// Read the disk identity of a resolved model path, following symlinks so the
/// identity reflects the bytes the engine loaders actually read. For a
/// directory model the fields aggregate over the contained files (sum of sizes,
/// latest mtime), because a file overwritten in place leaves the directory's
/// own mtime untouched. Returns `None` when the path cannot be stat'd, which
/// the cache treats as "cannot confirm reuse" and reloads.
fn disk_identity(path: &Path) -> Option<DiskIdentity> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_dir() {
        return Some(DiskIdentity {
            len: meta.len(),
            mtime: meta.modified().ok(),
        });
    }
    let mut len = 0u64;
    let mut mtime = meta.modified().ok();
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(child) = entry.metadata() else {
                continue;
            };
            if child.is_dir() {
                stack.push(entry.path());
            } else {
                len = len.saturating_add(child.len());
                if let Ok(t) = child.modified() {
                    mtime = Some(mtime.map_or(t, |cur| cur.max(t)));
                }
            }
        }
    }
    Some(DiskIdentity { len, mtime })
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
    fn parse_moonshine_variant_handles_known_names() {
        assert!(matches!(
            parse_moonshine_variant("moonshine-tiny-en").unwrap(),
            MoonshineVariant::Tiny
        ));
        assert!(matches!(
            parse_moonshine_variant("moonshine-base-en").unwrap(),
            MoonshineVariant::Base
        ));
    }

    #[test]
    fn parse_moonshine_variant_rejects_unknown_names() {
        assert!(parse_moonshine_variant("moonshine-large-en").is_err());
        assert!(parse_moonshine_variant("whisper-tiny").is_err());
    }

    #[test]
    fn disk_identity_stable_when_unchanged() {
        let dir = std::env::temp_dir().join(format!("whispering-id-stable-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.bin");
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
        let dir = std::env::temp_dir().join(format!("whispering-id-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.bin");

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
    fn disk_identity_detects_in_place_edit_in_directory_model() {
        let root = std::env::temp_dir().join(format!("whispering-id-dir-{}", std::process::id()));
        let model_dir = root.join("parakeet-model");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("encoder.onnx"), b"enc").unwrap();
        std::fs::write(model_dir.join("decoder.onnx"), b"dec").unwrap();

        let before = disk_identity(&model_dir).expect("identity for directory model");

        // Overwrite one contained file in place with same-length content: the
        // directory's own mtime would not move, but the aggregated mtime must.
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(model_dir.join("encoder.onnx"), b"ENC").unwrap();
        let after = disk_identity(&model_dir).expect("identity after in-place edit");
        assert_ne!(
            before, after,
            "an in-place file edit changes the directory model's identity"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn disk_identity_none_for_missing_path() {
        let path = std::env::temp_dir().join("whispering-id-missing-does-not-exist");
        std::fs::remove_file(&path).ok();
        assert!(disk_identity(&path).is_none());
    }

    #[test]
    fn state_for_spec_uses_captured_model_identity() {
        let spec = TranscriptionSpec {
            engine: EngineKind::Parakeet,
            model_name: "parakeet-tdt-0.6b-v3-int8".to_string(),
            language: Some("en".to_string()),
            initial_prompt: None,
        };

        let state = state_for_spec(&spec, ModelStatus::Inferring);

        assert_eq!(state.engine, Some(EngineKind::Parakeet));
        assert_eq!(
            state.model_name,
            Some("parakeet-tdt-0.6b-v3-int8".to_string())
        );
        assert_eq!(state.status, ModelStatus::Inferring);
    }
}
