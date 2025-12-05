# Fix Whisper C++ Linux Crash (Issue #914)

## Problem Statement

The application crashes immediately when attempting to transcribe recordings using Whisper C++ on Linux. Based on code analysis, the most likely root cause is mutex poisoning from panics in the `transcribe-rs` library, combined with extensive use of `.unwrap()` on mutex locks that causes cascading crashes.

## Root Cause Analysis

### Primary Issue: Mutex Poisoning
- Multiple `lock().unwrap()` calls throughout `model_manager.rs` and `mod.rs`
- If `transcribe-rs` panics during model loading (Linux-specific bugs), it poisons the ModelManager mutexes
- All subsequent transcription attempts crash due to poisoned mutex unwrapping
- No panic handling or recovery mechanism exists

### Secondary Issues
1. **transcribe-rs Library (v0.1.0)**: May have Linux-specific bugs in Whisper model loading
2. **Lack of Diagnostics**: No crash logging or structured logging for debugging
3. **No Model Validation**: No pre-flight checks before loading models on Linux
4. **No Timeouts**: Operations can hang indefinitely

## Implementation Plan

### ✅ TODO List

- [x] **Solution 1: Add Panic Handling and Crash Logging**
  - [x] Add panic hook to capture panic messages before crash
  - [x] Write crash logs to `/tmp/whispering-crash.log` on Linux
  - [x] Add structured logging throughout transcription pipeline

- [x] **Solution 2: Replace unwrap() with Proper Error Handling**
  - [x] Update `model_manager.rs` to handle poisoned mutexes
  - [x] Update `mod.rs` to handle poisoned mutexes
  - [x] Map mutex errors to proper TranscriptionError variants

- [ ] **Solution 3: Add Linux-Specific Model Loading Safeguards**
  - [ ] Validate model file exists and is readable
  - [ ] Check file size is reasonable (>1MB)
  - [ ] Add panic guards around `transcribe-rs` calls
  - [ ] Improve error messages with Linux-specific troubleshooting

- [ ] **Solution 4: Add Transcription Timeout**
  - [ ] Wrap transcription in 5-minute timeout
  - [ ] Return proper error on timeout

- [ ] **Testing**
  - [ ] Verify builds successfully on Linux
  - [ ] Add inline documentation for panic handling

## Technical Approach

### 1. Panic Handling (lib.rs)

Add a panic hook that captures panic information and writes to a log file on Linux. This allows users to report crashes with actual diagnostic information.

**Key points**:
- Set up before any other initialization
- Write to `/tmp/whispering-crash.log` on Linux
- Include timestamp, location, and panic message
- Forward details through the central logging pipeline for consistent diagnostics

### 1.5 Logging Integration (tauri-plugin-log)

Adopt `tauri-plugin-log` so all diagnostics land in stdout and the per-platform log directory.

**Key points**:
- Register the plugin during app bootstrap with stdout and log-dir targets and sensible rotation defaults
- Use `log` crate macros (`info!`, `warn!`, `debug!`, `error!`) instead of `println!`
- Raise the logging level for the transcription module so deep diagnostics stay available without spamming the rest of the app

### 2. Replace unwrap() Calls

Transform all `lock().unwrap()` patterns to proper error handling:

**Before**:
```rust
let mut engine_guard = self.engine.lock().unwrap();
```

**After**:
```rust
let mut engine_guard = self.engine.lock()
    .map_err(|e| format!("Engine mutex poisoned: {}", e))?;
```

**Files to update**:
- `model_manager.rs`: 12 occurrences
- `mod.rs`: 2 occurrences

### 3. Linux Model Loading Safeguards

Add pre-flight checks specifically for Linux:
- File existence check
- File readability check
- File size validation (minimum 1MB)
- Wrap `transcribe-rs` calls in `catch_unwind` to prevent panics from crashing app

### 4. Transcription Timeout

Use `tokio::time::timeout` to wrap the entire transcription operation with a 5-minute limit. This prevents indefinite hangs that appear as crashes.

## Files to Modify

1. **apps/whispering/src-tauri/src/lib.rs**
   - Add panic hook with crash logging
   - Register the log plugin and move existing prints to structured logging

2. **apps/whispering/src-tauri/src/transcription/model_manager.rs**
   - Replace 12 `.unwrap()` calls with proper error handling
   - Add Linux model validation in `get_or_load_whisper()`
   - Add panic guards around `transcribe-rs` calls
   - Swap `eprintln!` with `log::error!` for poisoned mutex reporting

3. **apps/whispering/src-tauri/src/transcription/mod.rs**
   - Replace 2 `.unwrap()` calls with proper error handling
   - Add timeout to `transcribe_audio_whisper` command
   - Add structured logging throughout transcription pipeline

4. **apps/whispering/src-tauri/Cargo.toml**
   - Declare `log` and `tauri-plugin-log` dependencies

5. **apps/whispering/src-tauri/capabilities/**/*.json**
   - Grant the new log capability to windows that need access

## Testing Strategy

Since we cannot directly test on Linux in this environment, the implementation focuses on:
1. **Compile-time safety**: Using proper error types and Result propagation
2. **Runtime diagnostics**: Extensive logging to help users report issues
3. **Defensive programming**: Validating all assumptions before operations
4. **Graceful degradation**: Catching panics and returning errors instead of crashing

## Success Criteria

- [x] No more `.unwrap()` calls on mutex locks in transcription code
- [x] Panic hook installed and writing to crash log on Linux
- [ ] Model loading includes pre-flight validation on Linux
- [ ] Transcription operations have timeout protection
- [x] Structured logging provides diagnostic information
- [ ] Code compiles successfully (verified with `cargo check`)

## Open Questions

1. Is there a newer version of `transcribe-rs` available? (v0.1.0 is very early)
2. Should we consider alternative Whisper C++ bindings for better Linux support?
3. What is the typical model file size range for validation?

## Related Issues

- #913: Sounds do not play on Ubuntu Linux
- #834: Linux version of Whispering seems to be somewhat comprehensively broken
- #798: Linux File System Permissions Issue
- #859: Blank window / freeze (Linux)

## Review Section

*To be completed after implementation*

### Changes Made
<!-- Summary of actual changes -->

### Testing Results
<!-- Compilation check results -->

### Outstanding Items
<!-- Any remaining work or follow-up needed -->
