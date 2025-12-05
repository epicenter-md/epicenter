# Persistent Model Manager Implementation Plan

## Executive Decision: Smart Default with User Control

After analyzing approaches and considering Whispering's user base, here's my recommendation:

### Recommended Strategy: **Intelligent Auto-Management with Settings**

**Default Behavior** (no user action needed):
- Load model on first transcription
- Keep loaded for 5 minutes after last use
- Auto-unload after idle timeout
- Pre-load on app startup if model was recently used

**User Settings** (for power users):
- Auto (default): Smart timeout (5 min)
- Always Loaded: Never unload (fastest)
- Unload Immediately: Free memory instantly (slowest)
- Custom timeout: 1min, 10min, 30min, etc.

### Why This Approach?

1. **Zero configuration for 90% of users**: Just works, fast by default
2. **Memory-conscious**: Doesn't hold RAM unnecessarily
3. **Power user friendly**: Settings for those who care
4. **Matches user patterns**: Most users do 2-5 transcriptions in quick succession, then stop

---

## Implementation Architecture

### Phase 1: Core Model Manager (Week 1)

#### 1.1: Create Model Manager Module

**File**: `apps/whispering/src-tauri/src/transcription/model_manager.rs`

```rust
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::path::PathBuf;
use transcribe_rs::{
    TranscriptionEngine,
    engines::parakeet::{ParakeetEngine, ParakeetModelParams, ParakeetInferenceParams, TimestampGranularity},
};
use anyhow::{Result, anyhow};
use tracing::{info, debug, warn};

/// Configuration for model management
#[derive(Debug, Clone)]
pub struct ModelManagerConfig {
    /// How long to keep model loaded after last use
    pub idle_timeout: Duration,
    /// Whether to unload immediately after each transcription
    pub unload_immediately: bool,
    /// Whether to preload model on app startup
    pub preload_on_startup: bool,
}

impl Default for ModelManagerConfig {
    fn default() -> Self {
        Self {
            idle_timeout: Duration::from_secs(5 * 60), // 5 minutes
            unload_immediately: false,
            preload_on_startup: false,
        }
    }
}

/// Manages model lifecycle to avoid repeated loading
pub struct ModelManager {
    /// Current loaded engine (None if unloaded)
    engine: Arc<Mutex<Option<ParakeetEngine>>>,

    /// Path to currently loaded model (if any)
    current_model_path: Arc<Mutex<Option<PathBuf>>>,

    /// Last time model was used
    last_used: Arc<Mutex<Instant>>,

    /// Configuration
    config: Arc<Mutex<ModelManagerConfig>>,

    /// Whether a model is currently loading
    is_loading: Arc<Mutex<bool>>,
}

impl ModelManager {
    pub fn new(config: ModelManagerConfig) -> Self {
        Self {
            engine: Arc::new(Mutex::new(None)),
            current_model_path: Arc::new(Mutex::new(None)),
            last_used: Arc::new(Mutex::new(Instant::now())),
            config: Arc::new(Mutex::new(config)),
            is_loading: Arc::new(Mutex::new(false)),
        }
    }

    /// Check if a model is currently loaded
    pub fn is_loaded(&self) -> bool {
        self.engine.lock().unwrap().is_some()
    }

    /// Get the path of currently loaded model
    pub fn current_model(&self) -> Option<PathBuf> {
        self.current_model_path.lock().unwrap().clone()
    }

    /// Load model if not already loaded, or if different model requested
    pub fn ensure_model_loaded(&self, model_path: &PathBuf) -> Result<()> {
        let mut engine_guard = self.engine.lock().unwrap();
        let mut path_guard = self.current_model_path.lock().unwrap();
        let mut is_loading = self.is_loading.lock().unwrap();

        // Check if already loading
        if *is_loading {
            return Err(anyhow!("Model is already loading, please wait"));
        }

        // Check if same model is already loaded
        if let Some(loaded_path) = path_guard.as_ref() {
            if loaded_path == model_path {
                debug!("Model already loaded: {:?}", model_path);
                return Ok(());
            } else {
                info!("Switching models: {:?} -> {:?}", loaded_path, model_path);
                // Unload old model
                if let Some(old_engine) = engine_guard.as_mut() {
                    old_engine.unload_model();
                }
                *engine_guard = None;
            }
        }

        // Mark as loading
        *is_loading = true;
        drop(is_loading);

        // Load new model
        info!("Loading Parakeet model: {:?}", model_path);
        let load_start = Instant::now();

        let mut new_engine = ParakeetEngine::new();
        match new_engine.load_model_with_params(model_path, ParakeetModelParams::int8()) {
            Ok(_) => {
                let load_duration = load_start.elapsed();
                info!("Model loaded successfully in {:?}", load_duration);

                *engine_guard = Some(new_engine);
                *path_guard = Some(model_path.clone());

                // Update last used time
                *self.last_used.lock().unwrap() = Instant::now();

                // Mark as not loading
                *self.is_loading.lock().unwrap() = false;

                Ok(())
            }
            Err(e) => {
                warn!("Failed to load model: {}", e);
                *self.is_loading.lock().unwrap() = false;
                Err(anyhow!("Failed to load model: {}", e))
            }
        }
    }

    /// Transcribe audio samples with the loaded model
    pub fn transcribe(&self, samples: Vec<f32>) -> Result<String> {
        let mut engine_guard = self.engine.lock().unwrap();

        let engine = engine_guard
            .as_mut()
            .ok_or_else(|| anyhow!("No model loaded. Call ensure_model_loaded first."))?;

        let params = ParakeetInferenceParams {
            timestamp_granularity: TimestampGranularity::Segment,
            ..Default::default()
        };

        let transcribe_start = Instant::now();
        let result = engine.transcribe_samples(samples, Some(params))
            .map_err(|e| anyhow!("Transcription failed: {}", e))?;
        let transcribe_duration = transcribe_start.elapsed();

        debug!("Transcription took {:?}", transcribe_duration);

        // Update last used time
        *self.last_used.lock().unwrap() = Instant::now();

        // Check if should unload immediately
        let config = self.config.lock().unwrap();
        if config.unload_immediately {
            drop(config);
            drop(engine_guard);
            self.unload_model()?;
        }

        Ok(result.text.trim().to_string())
    }

    /// Manually unload the model to free memory
    pub fn unload_model(&self) -> Result<()> {
        let mut engine_guard = self.engine.lock().unwrap();
        let mut path_guard = self.current_model_path.lock().unwrap();

        if let Some(engine) = engine_guard.as_mut() {
            info!("Unloading model: {:?}", *path_guard);
            engine.unload_model();
        }

        *engine_guard = None;
        *path_guard = None;

        Ok(())
    }

    /// Check if model should be unloaded due to idle timeout
    pub fn check_idle_timeout(&self) -> Result<bool> {
        let config = self.config.lock().unwrap();

        // Skip if immediate unload or no timeout
        if config.unload_immediately || config.idle_timeout.is_zero() {
            return Ok(false);
        }

        let last_used = *self.last_used.lock().unwrap();
        let elapsed = last_used.elapsed();

        if elapsed > config.idle_timeout {
            let is_loaded = self.is_loaded();
            if is_loaded {
                info!("Model idle timeout reached ({:?}), unloading", config.idle_timeout);
                drop(config);
                self.unload_model()?;
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Update configuration
    pub fn update_config(&self, new_config: ModelManagerConfig) {
        let mut config = self.config.lock().unwrap();
        *config = new_config;
        info!("Model manager config updated: {:?}", *config);
    }

    /// Get current configuration
    pub fn get_config(&self) -> ModelManagerConfig {
        self.config.lock().unwrap().clone()
    }

    /// Get time since last use
    pub fn time_since_last_use(&self) -> Duration {
        self.last_used.lock().unwrap().elapsed()
    }
}

// Start background idle checker
pub fn start_idle_checker(model_manager: Arc<ModelManager>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(30)); // Check every 30 seconds

            if let Err(e) = model_manager.check_idle_timeout() {
                warn!("Error checking idle timeout: {}", e);
            }
        }
    });
}
```

#### 1.2: Integrate with Tauri App State

**File**: `apps/whispering/src-tauri/src/lib.rs`

```rust
use std::sync::Arc;
use transcription::model_manager::{ModelManager, ModelManagerConfig, start_idle_checker};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Create model manager with default config
            let config = ModelManagerConfig::default();
            let model_manager = Arc::new(ModelManager::new(config));

            // Start idle checker background thread
            start_idle_checker(model_manager.clone());

            // Store in app state
            app.manage(model_manager);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            transcribe_audio_parakeet,
            get_model_status,
            update_model_config,
            manually_unload_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

#### 1.3: Update Transcription Command

**File**: `apps/whispering/src-tauri/src/transcription/mod.rs`

```rust
use crate::transcription::model_manager::ModelManager;

#[tauri::command]
pub async fn transcribe_audio_parakeet(
    audio_data: Vec<u8>,
    model_path: String,
    model_manager: tauri::State<'_, Arc<ModelManager>>,
) -> Result<String, TranscriptionError> {
    // Convert audio to whisper format (if needed)
    let wav_data = convert_audio_for_whisper(audio_data)?;

    // Extract samples
    let samples = extract_samples_from_wav(wav_data)?;

    if samples.is_empty() {
        return Ok(String::new());
    }

    // Ensure model is loaded
    model_manager.ensure_model_loaded(&PathBuf::from(&model_path))
        .map_err(|e| TranscriptionError::ModelLoadError {
            message: format!("Failed to load model: {}", e)
        })?;

    // Transcribe with loaded model
    model_manager.transcribe(samples)
        .map_err(|e| TranscriptionError::TranscriptionError {
            message: e.to_string(),
        })
}

// New commands for model management
#[tauri::command]
pub async fn get_model_status(
    model_manager: tauri::State<'_, Arc<ModelManager>>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "is_loaded": model_manager.is_loaded(),
        "current_model": model_manager.current_model().map(|p| p.to_string_lossy().to_string()),
        "time_since_last_use_secs": model_manager.time_since_last_use().as_secs(),
        "config": {
            "idle_timeout_secs": model_manager.get_config().idle_timeout.as_secs(),
            "unload_immediately": model_manager.get_config().unload_immediately,
            "preload_on_startup": model_manager.get_config().preload_on_startup,
        }
    }))
}

#[tauri::command]
pub async fn update_model_config(
    idle_timeout_secs: u64,
    unload_immediately: bool,
    preload_on_startup: bool,
    model_manager: tauri::State<'_, Arc<ModelManager>>,
) -> Result<(), String> {
    use crate::transcription::model_manager::ModelManagerConfig;

    let config = ModelManagerConfig {
        idle_timeout: Duration::from_secs(idle_timeout_secs),
        unload_immediately,
        preload_on_startup,
    };

    model_manager.update_config(config);
    Ok(())
}

#[tauri::command]
pub async fn manually_unload_model(
    model_manager: tauri::State<'_, Arc<ModelManager>>,
) -> Result<(), String> {
    model_manager.unload_model()
        .map_err(|e| e.to_string())
}
```

---

## Phase 2: Frontend Settings UI (Week 1-2)

### 2.1: Settings Schema

**File**: `apps/whispering/src/lib/schemas/settings.ts`

```typescript
export type ModelMemoryStrategy =
  | 'auto'           // Smart 5-min timeout (default)
  | 'always-loaded'  // Never unload
  | 'immediate'      // Unload after each use
  | 'custom';        // User-defined timeout

export type ModelSettings = {
  memoryStrategy: ModelMemoryStrategy;
  customTimeoutMinutes: number; // Used when strategy is 'custom'
  preloadOnStartup: boolean;
  showMemoryUsage: boolean; // Show RAM usage in status bar
};

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  memoryStrategy: 'auto',
  customTimeoutMinutes: 5,
  preloadOnStartup: false,
  showMemoryUsage: false,
};
```

### 2.2: Settings UI Component

**File**: `apps/whispering/src/lib/components/settings/ModelMemorySettings.svelte`

```svelte
<script lang="ts">
  import * as rpc from '$lib/query';
  import { createMutation } from '@tanstack/svelte-query';
  import { Button } from '$lib/components/ui/button';
  import * as Select from '$lib/components/ui/select';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';

  type Props = {
    settings: ModelSettings;
  };

  let { settings = $bindable() }: Props = $props();

  const updateMutation = createMutation(rpc.updateModelConfig.options);

  function handleStrategyChange(value: ModelMemoryStrategy) {
    settings.memoryStrategy = value;
    applySettings();
  }

  function applySettings() {
    const timeoutSecs = getTimeoutSeconds();
    const unloadImmediately = settings.memoryStrategy === 'immediate';

    updateMutation.mutate({
      idleTimeoutSecs: timeoutSecs,
      unloadImmediately,
      preloadOnStartup: settings.preloadOnStartup,
    });
  }

  function getTimeoutSeconds(): number {
    switch (settings.memoryStrategy) {
      case 'always-loaded':
        return 0; // Never timeout
      case 'immediate':
        return 0; // Handled by unloadImmediately flag
      case 'custom':
        return settings.customTimeoutMinutes * 60;
      case 'auto':
      default:
        return 5 * 60; // 5 minutes
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h3 class="text-lg font-medium">Model Memory Management</h3>
    <p class="text-sm text-muted-foreground">
      Control how Whispering manages model memory for optimal performance.
    </p>
  </div>

  <div class="space-y-4">
    <div class="space-y-2">
      <Label for="strategy">Memory Strategy</Label>
      <Select.Root
        selected={{ value: settings.memoryStrategy }}
        onSelectedChange={(v) => v && handleStrategyChange(v.value)}
      >
        <Select.Trigger id="strategy">
          <Select.Value placeholder="Select strategy" />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="auto">
            <div>
              <div class="font-medium">Auto (Recommended)</div>
              <div class="text-xs text-muted-foreground">
                Keep loaded for 5 minutes after use
              </div>
            </div>
          </Select.Item>

          <Select.Item value="always-loaded">
            <div>
              <div class="font-medium">Always Loaded</div>
              <div class="text-xs text-muted-foreground">
                Fastest, uses ~500-800 MB RAM
              </div>
            </div>
          </Select.Item>

          <Select.Item value="immediate">
            <div>
              <div class="font-medium">Unload Immediately</div>
              <div class="text-xs text-muted-foreground">
                Slowest, minimal memory usage
              </div>
            </div>
          </Select.Item>

          <Select.Item value="custom">
            <div>
              <div class="font-medium">Custom Timeout</div>
              <div class="text-xs text-muted-foreground">
                Set your own idle timeout
              </div>
            </div>
          </Select.Item>
        </Select.Content>
      </Select.Root>
    </div>

    {#if settings.memoryStrategy === 'custom'}
      <div class="space-y-2">
        <Label for="timeout">Unload After (minutes)</Label>
        <Input
          id="timeout"
          type="number"
          min="1"
          max="60"
          bind:value={settings.customTimeoutMinutes}
          onchange={applySettings}
        />
      </div>
    {/if}

    <div class="flex items-center justify-between">
      <div class="space-y-0.5">
        <Label>Preload on Startup</Label>
        <div class="text-sm text-muted-foreground">
          Load model when app starts (slower startup, faster first transcription)
        </div>
      </div>
      <Switch
        checked={settings.preloadOnStartup}
        onCheckedChange={(checked) => {
          settings.preloadOnStartup = checked;
          applySettings();
        }}
      />
    </div>

    <div class="flex items-center justify-between">
      <div class="space-y-0.5">
        <Label>Show Memory Usage</Label>
        <div class="text-sm text-muted-foreground">
          Display RAM usage in status bar
        </div>
      </div>
      <Switch
        checked={settings.showMemoryUsage}
        onCheckedChange={(checked) => {
          settings.showMemoryUsage = checked;
        }}
      />
    </div>
  </div>

  <div class="rounded-lg border p-4 space-y-2">
    <div class="text-sm font-medium">Performance Impact</div>
    {#if settings.memoryStrategy === 'auto'}
      <p class="text-sm text-muted-foreground">
        First transcription: ~1.5s (loads model)<br/>
        Subsequent transcriptions (within 5 min): ~0.3s (5x faster!)
      </p>
    {:else if settings.memoryStrategy === 'always-loaded'}
      <p class="text-sm text-muted-foreground">
        First transcription: ~1.5s (loads model)<br/>
        All subsequent transcriptions: ~0.3s (fastest!)
      </p>
    {:else if settings.memoryStrategy === 'immediate'}
      <p class="text-sm text-muted-foreground">
        All transcriptions: ~1.5s (loads every time)<br/>
        Uses minimal memory, but much slower
      </p>
    {:else}
      <p class="text-sm text-muted-foreground">
        Transcriptions within {settings.customTimeoutMinutes} min: ~0.3s<br/>
        After timeout: ~1.5s (reloads model)
      </p>
    {/if}
  </div>
</div>
```

---

## Phase 3: Status Indicator (Week 2)

### 3.1: Model Status Component

**File**: `apps/whispering/src/lib/components/ModelStatusIndicator.svelte`

```svelte
<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import * as rpc from '$lib/query';
  import { Badge } from '$lib/components/ui/badge';

  const statusQuery = createQuery(rpc.getModelStatus.options, {
    refetchInterval: 5000, // Update every 5 seconds
  });

  $: status = $statusQuery.data;
  $: isLoaded = status?.is_loaded ?? false;
  $: timeSinceUse = status?.time_since_last_use_secs ?? 0;
</script>

{#if $statusQuery.isSuccess}
  <div class="flex items-center gap-2">
    <Badge variant={isLoaded ? 'default' : 'secondary'}>
      {#if isLoaded}
        <span class="flex items-center gap-1">
          <span class="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
          Model Loaded
        </span>
      {:else}
        <span class="text-muted-foreground">Model Unloaded</span>
      {/if}
    </Badge>

    {#if isLoaded && timeSinceUse > 0}
      <span class="text-xs text-muted-foreground">
        Last used {timeSinceUse}s ago
      </span>
    {/if}
  </div>
{/if}
```

---

## Recommended Settings Strategy

### Default for All Users: "Auto" Mode

```typescript
const DEFAULT_CONFIG = {
  memoryStrategy: 'auto',      // 5-minute timeout
  preloadOnStartup: false,      // Don't slow down startup
  showMemoryUsage: false,       // Don't clutter UI
};
```

**Why this works:**

1. **Handles typical usage**: Users do 2-5 transcriptions in succession
2. **Memory-conscious**: Unloads after 5 minutes of inactivity
3. **Zero config needed**: Works great out of the box
4. **Power users can override**: Settings available for those who want them

### User Scenarios

**Casual User** (default settings):
- Does 3 transcriptions in a row
- Model loads on first (1.5s)
- Next 2 are fast (0.3s each)
- Model unloads after 5 min idle
- ✅ Perfect, no configuration needed

**Power User** (always loaded):
- Does 50+ transcriptions per day
- Changes setting to "Always Loaded"
- Model loads once at startup
- All transcriptions are fast (0.3s)
- Uses ~800 MB RAM constantly
- ✅ Worth it for them

**Memory-Conscious User** (immediate unload):
- Limited RAM system
- Changes setting to "Unload Immediately"
- Every transcription is slow (1.5s)
- But uses minimal memory
- ✅ Their choice, their trade-off

---

## Implementation Timeline

### Week 1: Core Implementation
- **Day 1-2**: Model manager module (model_manager.rs)
- **Day 3**: Tauri integration and commands
- **Day 4**: Update transcription command
- **Day 5**: Testing and bug fixes

### Week 2: UI and Polish
- **Day 1-2**: Settings UI components
- **Day 3**: Status indicator
- **Day 4**: Integration testing
- **Day 5**: Documentation and release prep

---

## Testing Checklist

- [ ] Model loads correctly on first transcription
- [ ] Subsequent transcriptions reuse loaded model
- [ ] Model switches correctly when changing models
- [ ] Idle timeout works correctly
- [ ] Immediate unload mode works
- [ ] Always loaded mode works
- [ ] Settings persist across app restarts
- [ ] No memory leaks with long-running sessions
- [ ] Handles concurrent transcription requests
- [ ] Status indicator updates correctly
- [ ] macOS, Windows, Linux compatibility

---

## Success Metrics

### Performance
- ✅ First transcription: ~1.5s (acceptable, one-time cost)
- ✅ Subsequent transcriptions: ~0.3s (5x improvement)
- ✅ Memory usage: 500-800 MB when loaded (reasonable)

### User Experience
- ✅ No configuration needed for 90% of users
- ✅ Fast transcription feels instant
- ✅ Settings available for power users
- ✅ Clear status indicator shows what's happening

---

## Recommendation Summary

**Best approach**: Implement intelligent auto-management with the 5-minute idle timeout as the default.

**Why**:
1. Works great for typical usage patterns
2. Memory-conscious (unloads when not needed)
3. Zero configuration required
4. Power users can optimize further
5. Clear, simple mental model

**Don't do**: Always keep loaded by default (wastes memory for casual users)
**Don't do**: Unload immediately (loses all benefits)
**Do**: Smart default with user control

This gives you the speed benefits while being more memory-efficient and user-friendly.
