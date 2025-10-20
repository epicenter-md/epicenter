Title: Whispering Vulkan Runtime Compatibility — Plan

Context
- Recent issues confirm Windows/Linux crashes on systems without Vulkan:
  - epicenter-md/epicenter#840: CPU-only Windows systems fail after v7.4.0 due to vulkan-1.dll
  - epicenter-md/epicenter#829: “Vulkan-1.dll not found” at launch; 7.4.0 works, 7.5.x regresses
- Root cause: transcribe-rs enables whisper-rs with GPU backends by default
  - transcribe-rs Cargo.toml (0.1.4):
    - macOS → whisper-rs[metal]
    - Windows/Linux → whisper-rs[vulkan]
  - whisper-rs[vulkan] links Vulkan loader ⇒ Windows requires vulkan-1.dll; many systems lack it
- Our GitHub Actions currently install Vulkan SDK on Windows/Linux, reinforcing a build that requires Vulkan at runtime.
- Handy uses the same approach (Vulkan/Metal) and documents installing Vulkan packages. That’s fine for Handy’s audience, but it breaks Whispering’s goal of working on CPU-only systems out-of-the-box.

Decision
- Default Whispering builds must be CPU-only (no GPU feature linking) to run anywhere.
- Optional GPU-accelerated builds are nice-to-have but secondary; if kept, they should be clearly labeled and separate artifacts.

Plan
1) Freeze builds to CPU-only
   - Remove Vulkan SDK steps from CI for default jobs
   - Ensure “whisper-rs” is built without GPU features on all platforms

2) Patch dependency to stop forcing Vulkan/Metal
   - Fork or patch transcribe-rs to remove OS-target ‘features = ["vulkan"|"metal"]’ defaults
   - Expose an opt-in feature flag (e.g., transcribe-rs feature `gpu`) that conditionally enables whisper-rs backends
   - Pin Whispering to patched transcribe-rs via `[patch.crates-io]` or a git ref

3) Optional: Dual artifacts
   - If desired, add a separate CI job (e.g., `gpu-build`) that enables `--features gpu` and installs SDKs
   - Name assets clearly: `Whispering-<version>-cpu` vs `Whispering-<version>-gpu`

4) Release notes + Docs
   - Communicate that CPU builds are default and broadly compatible
   - Document optional GPU builds, with Vulkan/Metal prerequisites

TODO
- [ ] Confirm approach (CPU by default; optional GPU build)
- [ ] Remove Vulkan SDK steps in `.github/workflows/publish-tauri-releases.yml` default matrix
- [ ] Patch dependency: use a fork/branch of transcribe-rs without Vulkan/Metal defaults
- [ ] Update `apps/whispering/src-tauri/Cargo.toml` to pin patched transcribe-rs
- [ ] (Optional) Add `gpu` matrix job enabling GPU features and SDK installs
- [ ] Validate Windows/Linux builds launch on machines without Vulkan
- [ ] Add release notes and short README note

Notes
- We cannot “turn off” features set by a dependency; features are additive. So fixing this at the transcribe-rs level is required.
- Even if we never call WhisperEngine, enabling whisper-rs[vulkan] still pulls in the Vulkan loader import, causing runtime failures.

Review (to be filled after implementation)
- Summary of changes
- CI artifacts produced and tested
- Any follow-ups (e.g., contribute a PR upstream to make CPU default)

