# Vulkan Support Investigation: Fix CPU-Only Systems Crash

**Date**: 2025-10-20
**Status**: Investigation Phase

## Problem Statement

Whispering crashes on CPU-only Windows systems after v7.4.0 with error "vulkan-1.dll not found". The application requires Vulkan runtime libraries even when GPU acceleration is not being used, making it unusable on systems without dedicated GPU or proper Vulkan driver support.

### Affected Issues
- #840: Whispering crashes on Windows CPU-only systems after v7.4.0 due to vulkan-1.dll
- #829: Vulkan-1.dll not found error at launch

### Impact
- **Severity**: Critical (application unusable)
- **Affected Versions**: v7.4.0+
- **Platform**: Windows (primarily), potentially Linux
- **User Impact**: All users on CPU-only systems or systems without Vulkan drivers

## Root Cause Analysis

### Current Build Configuration

1. **GitHub Actions Workflow** (`/.github/workflows/publish-tauri-releases.yml`):
   - **Lines 62-85**: Explicitly installs Vulkan SDK on all platforms
     - Windows: Vulkan SDK v1.4.309.0 (line 80-85)
     - Linux: Vulkan SDK v1.3.290 + mesa-vulkan-drivers (line 63-71)
     - macOS: No Vulkan installation (uses Metal instead)

2. **Rust Dependencies** (`/apps/whispering/src-tauri/Cargo.toml`):
   - **Line 51**: `transcribe-rs = "0.1.0"` (no features specified)
   - Dependency chain: `transcribe-rs` → `whisper-rs 0.13.2` → `whisper-rs-sys 0.11.1` → `whisper.cpp`

3. **whisper-rs Configuration**:
   - Default build includes NO GPU features enabled
   - Available GPU features (all opt-in): `cuda`, `hipblas`, `metal`, `vulkan`, `openblas`
   - **However**: whisper.cpp's CMake build may still include Vulkan support by default when Vulkan SDK is detected in environment

### The Disconnect

The issue occurs because:

1. **Build-time**: GitHub Actions installs Vulkan SDK in the build environment
2. **Compilation**: When whisper-rs-sys's build.rs runs cmake to compile whisper.cpp, it may detect the Vulkan SDK and automatically enable Vulkan support
3. **Runtime**: The compiled binary expects vulkan-1.dll to be present, even though:
   - whisper-rs doesn't have the `vulkan` feature enabled
   - The application code never uses GPU acceleration
   - Users' systems may not have Vulkan installed

### Code Evidence

**Model Manager** (`/apps/whispering/src-tauri/src/transcription/model_manager.rs`):
- Line 65: `ParakeetEngine::new()` - no GPU parameters
- Line 105: `WhisperEngine::new()` - no GPU parameters
- No GPU acceleration configuration anywhere in the codebase

**Transcription Module** (`/apps/whispering/src-tauri/src/transcription/mod.rs`):
- Lines 43-263: Audio conversion is pure Rust (CPU-based resampling)
- Lines 413-471: Whisper transcription uses CPU samples
- No GPU-related code paths

**Error Types** (`/apps/whispering/src-tauri/src/transcription/error.rs`):
- Line 13-14: `GpuError` is defined but never used in the codebase

## Solution Approaches

### Approach 1: Remove Vulkan SDK from Build (Recommended for Immediate Fix)
**Pros:**
- Simple: Remove lines 62-85 from GitHub Actions workflow
- Ensures CPU-only build
- No runtime Vulkan dependency
- Works across all platforms consistently

**Cons:**
- Prevents future GPU acceleration features
- Requires rebuilding and redistributing
- Users with GPU won't benefit from acceleration

**Implementation:**
1. Comment out or remove Vulkan SDK installation steps from `.github/workflows/publish-tauri-releases.yml` (lines 62-85)
2. Test build locally or in CI to ensure whisper.cpp compiles without Vulkan
3. Test on clean Windows VM without Vulkan to verify no dependency
4. Release new version v7.5.6 with CPU-only build

**Files to modify:**
- `.github/workflows/publish-tauri-releases.yml` - remove lines 62-85

### Approach 2: Explicit CPU-Only Build Flag (More Complex)
**Pros:**
- Explicit control over build configuration
- Prevents accidental GPU backend inclusion even if Vulkan SDK is present
- Future-proof: can add GPU features later with proper feature flags

**Cons:**
- Requires modifying whisper-rs-sys build.rs or using environment variables
- More complex to maintain
- May require forking whisper-rs-sys if upstream doesn't accept changes

**Implementation:**
1. Research whisper-rs-sys build.rs to understand how to pass CMake flags
2. Add environment variable in GitHub Actions: `CMAKE_ARGS=-DGGML_VULKAN=0`
3. Or create custom build.rs in Whispering that overrides whisper-rs-sys
4. Test on clean Windows VM without Vulkan

**Challenges:**
- whisper-rs-sys uses cmake-rs crate which has specific API for setting flags
- May need to set `CXXFLAGS` or `CMAKE_CXX_FLAGS` environment variables
- Unclear if whisper.cpp respects `-DGGML_VULKAN=0` (may need `-DGGML_VULKAN=OFF`)

### Approach 3: Feature-Gated Builds (Long-term)
**Pros:**
- Users can choose GPU or CPU builds
- Optimal performance for each use case
- Industry standard approach

**Cons:**
- More complex CI/CD pipeline
- Multiple build artifacts to maintain
- Larger repository size

**Implementation:**
1. Create Cargo features: `gpu-vulkan`, `gpu-cuda`, etc.
2. Modify CI to build multiple variants
3. Add feature selection in tauri.conf.json or during build

### Approach 4: Dynamic GPU Backend Loading
**Pros:**
- Single binary for all scenarios
- Graceful degradation if GPU not available

**Cons:**
- Complex implementation
- May still require Vulkan headers at build time
- Not supported by current whisper-rs architecture

## Investigation into Handy

Analyzed Handy repository (braden-w/handy) to understand their approach:

### Findings

**Cargo.toml** (`/tmp/handy/src-tauri/Cargo.toml`):
- **Line 67**: Uses `transcribe-rs = "0.1.0"` (same as Whispering)
- **No GPU features enabled** - same basic configuration as Whispering
- Same dependency chain: transcribe-rs → whisper-rs → whisper-rs-sys → whisper.cpp

**GitHub Actions** (`/tmp/handy/.github/workflows/build.yml`):
- **Lines 92-97**: Installs Vulkan SDK on Windows (v1.4.309.0) - EXACTLY like Whispering
- **Lines 103-110**: Installs Vulkan SDK on Ubuntu 24.04 (v1.3.290)
- **Lines 112-119**: Installs Vulkan SDK on Ubuntu 22.04 (v1.3.290)
- **No macOS Vulkan installation** (uses Metal instead)

### Critical Discovery

**Handy has the EXACT SAME configuration as Whispering** - they also install Vulkan SDK during builds and don't explicitly disable it. This means:

1. **Handy likely has the same issue** but it may not have been reported yet (their issues are disabled on GitHub)
2. **This is not a Whispering-specific problem** - it's an issue with how transcribe-rs/whisper-rs-sys builds whisper.cpp when Vulkan SDK is present
3. **The problem is at the whisper.cpp CMake level** - when Vulkan SDK is detected in the environment, whisper.cpp's build system automatically enables Vulkan support

### Why This Happens

whisper.cpp's CMake configuration has automatic GPU backend detection:
- If `VULKAN_SDK` environment variable is set, it enables Vulkan
- If CUDA is detected, it enables CUDA
- If Metal frameworks are available (macOS), it enables Metal

Since GitHub Actions sets up Vulkan SDK before the Rust build, whisper.cpp sees it and enables Vulkan support automatically, even though:
- whisper-rs doesn't have the `vulkan` feature flag enabled
- The application code never requests GPU acceleration
- The end users may not have Vulkan installed

## Recommended Action Plan

### Immediate Fix (v7.5.6) - **RECOMMENDED**

**Approach**: Remove Vulkan SDK installation from GitHub Actions (Approach 1)

**Rationale**:
- Simplest solution with minimal risk
- Addresses the critical issue immediately
- Handy has the same configuration, so this is an industry-standard approach
- Current codebase doesn't use GPU acceleration anyway

**Steps**:
1. [ ] Comment out lines 62-85 in `.github/workflows/publish-tauri-releases.yml`:
   - Windows Vulkan SDK installation (lines 79-85)
   - Linux Vulkan SDK installation (lines 62-71)
2. [ ] Push changes and trigger a test build
3. [ ] Download test build and verify on Windows VM without Vulkan
4. [ ] If successful, tag as v7.5.6 and publish release
5. [ ] Update GitHub issues #840 and #829 with the fix

**Expected Outcome**:
- Binary size may slightly decrease (no Vulkan backend code)
- Application will work on all CPU-only systems
- No Vulkan runtime dependency

### Short-term (v7.6.0)
- [ ] Add better error messages if model loading fails
- [ ] Document system requirements more clearly
- [ ] Create troubleshooting guide for local transcription issues

### Long-term (v8.0.0)
- [ ] Consider implementing optional GPU support with proper feature flags
- [ ] Add GPU selection UI in settings (if implementing GPU support)
- [ ] Benchmark CPU vs GPU transcription performance to determine if GPU support is worth the complexity

## Open Questions

1. ~~Why does whisper.cpp detect and enable Vulkan even without explicit flags?~~
   - **ANSWERED**: whisper.cpp's CMake automatically detects `VULKAN_SDK` environment variable and enables Vulkan support
2. ~~Does whisper-rs-sys's build.rs pass any implicit GPU flags to cmake?~~
   - **ANSWERED**: No, but cmake detects Vulkan SDK in environment automatically
3. Can we detect Vulkan availability at runtime and fall back to CPU gracefully?
   - **NOT FEASIBLE**: By the time the application runs, the binary is already compiled with Vulkan dependencies baked in
4. What's the performance difference between CPU-only and GPU-accelerated transcription?
   - **NEEDS TESTING**: Should benchmark before implementing GPU support in future
5. Should we notify Handy maintainers about this issue?
   - **RECOMMENDED**: They likely have the same problem but haven't received bug reports yet

## Summary

The Vulkan dependency issue stems from whisper.cpp's automatic GPU backend detection during compilation. When GitHub Actions installs Vulkan SDK, whisper.cpp's CMake build system automatically enables Vulkan support, creating a runtime dependency on vulkan-1.dll even though the application never uses GPU acceleration.

**Root Cause**: Build environment (Vulkan SDK present) ≠ Runtime environment (Vulkan may not be present)

**Solution**: Remove Vulkan SDK from build environment to ensure CPU-only compilation

**Impact**: Critical bug affecting all CPU-only Windows users on v7.4.0+

**Risk Level of Fix**: Low - application doesn't use GPU features, so removing GPU backend has no functional impact

## References

- whisper.cpp CMake options: https://github.com/ggml-org/whisper.cpp
- whisper-rs features: https://github.com/tazz4843/whisper-rs
- GitHub Issue #840: https://github.com/epicenter-md/epicenter/issues/840
- GitHub Issue #829: https://github.com/epicenter-md/epicenter/issues/829
