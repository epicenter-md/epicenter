use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use transcribe_rs::engines::parakeet::{ParakeetEngine, ParakeetModelParams};
use transcribe_rs::engines::whisper::WhisperEngine;
use transcribe_rs::TranscriptionEngine;

/// Engine type for managing different transcription engines
pub enum Engine {
    Parakeet(ParakeetEngine),
    Whisper(WhisperEngine),
}

impl Engine {
    fn unload(&mut self) {
        match self {
            Engine::Parakeet(e) => e.unload_model(),
            Engine::Whisper(e) => e.unload_model(),
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

    pub fn get_or_load_parakeet(&self, model_path: PathBuf) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        let mut engine_guard = self.engine.lock().unwrap();
        let mut current_path_guard = self.current_model_path.lock().unwrap();

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
        *self.last_activity.lock().unwrap() = SystemTime::now();

        Ok(self.engine.clone())
    }

    pub fn get_or_load_whisper(&self, model_path: PathBuf) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        let mut engine_guard = self.engine.lock().unwrap();
        let mut current_path_guard = self.current_model_path.lock().unwrap();

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
        *self.last_activity.lock().unwrap() = SystemTime::now();

        Ok(self.engine.clone())
    }

    pub fn unload_if_idle(&self) {
        let last_activity = *self.last_activity.lock().unwrap();
        let elapsed = SystemTime::now()
            .duration_since(last_activity)
            .unwrap_or(Duration::from_secs(0));

        if elapsed > self.idle_timeout {
            let mut engine_guard = self.engine.lock().unwrap();
            if let Some(mut engine) = engine_guard.take() {
                engine.unload();
            }
            *self.current_model_path.lock().unwrap() = None;
        }
    }

    pub fn unload_model(&self) {
        let mut engine_guard = self.engine.lock().unwrap();
        if let Some(mut engine) = engine_guard.take() {
            engine.unload();
        }
        *self.current_model_path.lock().unwrap() = None;
    }
}
