use log::error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
#[cfg(not(target_os = "windows"))]
use transcribe_rs::engines::moonshine::{MoonshineEngine, MoonshineModelParams};
use transcribe_rs::engines::parakeet::{ParakeetEngine, ParakeetModelParams};
#[cfg(not(target_os = "windows"))]
use transcribe_rs::engines::whisper::WhisperEngine;
use transcribe_rs::TranscriptionEngine;

use super::canary::CanaryEngine;

/// Engine type for managing different transcription engines
pub enum Engine {
    #[cfg(not(target_os = "windows"))]
    Whisper(WhisperEngine),
    Parakeet(ParakeetEngine),
    #[cfg(not(target_os = "windows"))]
    Moonshine(MoonshineEngine),
    /// Canary-1B-v2 with language support (works on all platforms)
    Canary(CanaryEngine),
}

impl Engine {
    fn unload(&mut self) {
        match self {
            Engine::Parakeet(e) => e.unload_model(),
            #[cfg(not(target_os = "windows"))]
            Engine::Whisper(e) => e.unload_model(),
            #[cfg(not(target_os = "windows"))]
            Engine::Moonshine(e) => e.unload_model(),
            Engine::Canary(e) => e.unload(),
        }
    }
}

pub struct ModelManager {
    engine: Arc<Mutex<Option<Engine>>>,
    current_model_path: Arc<Mutex<Option<PathBuf>>>,
    last_activity: Arc<Mutex<SystemTime>>,
    idle_timeout: Duration,
}

impl ModelManager {
    pub fn new() -> Self {
        Self {
            engine: Arc::new(Mutex::new(None)),
            current_model_path: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(Mutex::new(SystemTime::now())),
            idle_timeout: Duration::from_secs(5 * 60), // 5 minutes default
        }
    }

    pub fn get_or_load_parakeet(
        &self,
        model_path: PathBuf,
    ) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        let mut engine_guard = self.engine.lock().map_err(|e| {
            format!(
                "Engine mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;
        let mut current_path_guard = self.current_model_path.lock().map_err(|e| {
            format!(
                "Model path mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;

        // Check if we need to load a new model
        let needs_load = match (&*engine_guard, &*current_path_guard) {
            (None, _) => true,
            (Some(_), Some(path)) if path != &model_path => {
                // Different model requested, unload current one
                if let Some(mut engine) = engine_guard.take() {
                    engine.unload();
                }
                true
            }
            #[cfg(not(target_os = "windows"))]
            (Some(Engine::Whisper(_)), _) => {
                // Wrong engine type, unload and reload
                if let Some(mut engine) = engine_guard.take() {
                    engine.unload();
                }
                true
            }
            _ => false,
        };

        if needs_load {
            let mut engine = ParakeetEngine::new();
            engine
                .load_model_with_params(&model_path, ParakeetModelParams::int8())
                .map_err(|e| format!("Failed to load Parakeet model: {}", e))?;

            *engine_guard = Some(Engine::Parakeet(engine));
            *current_path_guard = Some(model_path);
        }

        // Update last activity
        let mut last_activity_guard = self
            .last_activity
            .lock()
            .map_err(|e| format!("Last activity mutex poisoned: {}", e))?;
        *last_activity_guard = SystemTime::now();

        Ok(self.engine.clone())
    }

    #[cfg(not(target_os = "windows"))]
    pub fn get_or_load_whisper(
        &self,
        model_path: PathBuf,
    ) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        let mut engine_guard = self.engine.lock().map_err(|e| {
            format!(
                "Engine mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;
        let mut current_path_guard = self.current_model_path.lock().map_err(|e| {
            format!(
                "Model path mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;

        // Check if we need to load a new model
        let needs_load = match (&*engine_guard, &*current_path_guard) {
            (None, _) => true,
            (Some(_), Some(path)) if path != &model_path => {
                // Different model requested, unload current one
                if let Some(mut engine) = engine_guard.take() {
                    engine.unload();
                }
                true
            }
            (Some(Engine::Parakeet(_)), _) => {
                // Wrong engine type, unload and reload
                if let Some(mut engine) = engine_guard.take() {
                    engine.unload();
                }
                true
            }
            _ => false,
        };

        if needs_load {
            let mut engine = WhisperEngine::new();
            engine
                .load_model(&model_path)
                .map_err(|e| format!("Failed to load Whisper model: {}", e))?;

            *engine_guard = Some(Engine::Whisper(engine));
            *current_path_guard = Some(model_path);
        }

        // Update last activity
        let mut last_activity_guard = self
            .last_activity
            .lock()
            .map_err(|e| format!("Last activity mutex poisoned: {}", e))?;
        *last_activity_guard = SystemTime::now();

        Ok(self.engine.clone())
    }

    #[cfg(target_os = "windows")]
    pub fn get_or_load_whisper(
        &self,
        _model_path: PathBuf,
    ) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        Err("Whisper C++ is not available on Windows due to build compatibility issues. Please use Parakeet for local transcription.".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    pub fn get_or_load_moonshine(
        &self,
        model_path: PathBuf,
        variant: MoonshineModelParams,
    ) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        let mut engine_guard = self.engine.lock().map_err(|e| {
            format!(
                "Engine mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;
        let mut current_path_guard = self.current_model_path.lock().map_err(|e| {
            format!(
                "Model path mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;

        // Check if we need to load a new model
        let needs_load = match (&*engine_guard, &*current_path_guard) {
            (None, _) => true,
            (Some(_), Some(path)) if path != &model_path => {
                // Different model requested, unload current one
                if let Some(mut engine) = engine_guard.take() {
                    engine.unload();
                }
                true
            }
            (Some(Engine::Whisper(_)), _) => {
                // Wrong engine type, unload and reload
                if let Some(mut engine) = engine_guard.take() {
                    engine.unload();
                }
                true
            }
            (Some(Engine::Parakeet(_)), _) => {
                // Wrong engine type, unload and reload
                if let Some(mut engine) = engine_guard.take() {
                    engine.unload();
                }
                true
            }
            _ => false,
        };

        if needs_load {
            let mut engine = MoonshineEngine::new();
            engine
                .load_model_with_params(&model_path, variant)
                .map_err(|e| format!("Failed to load Moonshine model: {}", e))?;

            *engine_guard = Some(Engine::Moonshine(engine));
            *current_path_guard = Some(model_path);
        }

        // Update last activity
        let mut last_activity_guard = self
            .last_activity
            .lock()
            .map_err(|e| format!("Last activity mutex poisoned: {}", e))?;
        *last_activity_guard = SystemTime::now();

        Ok(self.engine.clone())
    }

    #[cfg(target_os = "windows")]
    pub fn get_or_load_moonshine(
        &self,
        _model_path: PathBuf,
        _variant: &str,
    ) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        Err("Moonshine is not available on Windows due to build compatibility issues. Please use Parakeet for local transcription.".to_string())
    }

    /// Load Canary-1B-v2 model with language support
    /// Works on all platforms (Windows, macOS, Linux)
    pub fn get_or_load_canary(
        &self,
        model_path: PathBuf,
    ) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        let mut engine_guard = self.engine.lock().map_err(|e| {
            format!(
                "Engine mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;
        let mut current_path_guard = self.current_model_path.lock().map_err(|e| {
            format!(
                "Model path mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;

        // Check if we need to load a new model
        let needs_load = match (&*engine_guard, &*current_path_guard) {
            (None, _) => true,
            (Some(_), Some(path)) if path != &model_path => {
                // Different model requested, unload current one
                if let Some(mut engine) = engine_guard.take() {
                    engine.unload();
                }
                true
            }
            (Some(Engine::Canary(_)), _) => false, // Already have Canary loaded
            _ => {
                // Wrong engine type, unload and reload
                if let Some(mut engine) = engine_guard.take() {
                    engine.unload();
                }
                true
            }
        };

        if needs_load {
            let engine = CanaryEngine::load(&model_path)
                .map_err(|e| format!("Failed to load Canary model: {}", e))?;

            *engine_guard = Some(Engine::Canary(engine));
            *current_path_guard = Some(model_path);
        }

        // Update last activity
        let mut last_activity_guard = self
            .last_activity
            .lock()
            .map_err(|e| format!("Last activity mutex poisoned: {}", e))?;
        *last_activity_guard = SystemTime::now();

        Ok(self.engine.clone())
    }

    pub fn unload_if_idle(&self) {
        let last_activity = match self.last_activity.lock() {
            Ok(guard) => *guard,
            Err(e) => {
                error!(
                    "Last activity mutex poisoned while checking idle unload: {}",
                    e
                );
                return;
            }
        };
        let elapsed = SystemTime::now()
            .duration_since(last_activity)
            .unwrap_or(Duration::from_secs(0));

        if elapsed > self.idle_timeout {
            let mut engine_guard = match self.engine.lock() {
                Ok(guard) => guard,
                Err(e) => {
                    error!("Engine mutex poisoned while unloading idle model: {}", e);
                    return;
                }
            };
            if let Some(mut engine) = engine_guard.take() {
                engine.unload();
            }
            if let Ok(mut current_path_guard) = self.current_model_path.lock() {
                *current_path_guard = None;
            } else {
                error!("Model path mutex poisoned while clearing idle model path after unload");
            }
        }
    }

    pub fn unload_model(&self) {
        let mut engine_guard = match self.engine.lock() {
            Ok(guard) => guard,
            Err(e) => {
                error!("Engine mutex poisoned while unloading model: {}", e);
                return;
            }
        };
        if let Some(mut engine) = engine_guard.take() {
            engine.unload();
        }
        if let Ok(mut current_path_guard) = self.current_model_path.lock() {
            *current_path_guard = None;
        } else {
            error!("Model path mutex poisoned while clearing model path after unload");
        }
    }
}
