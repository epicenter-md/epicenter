Title: Auto pause/resume media on macOS during recording

Problem
- When starting a Whispering recording via keyboard shortcut, music keeps playing. We want Whispering to auto-pause active media at start and auto-resume at the end, with a user setting (default on), macOS-only for v1.

Scope
- Platform: macOS only
- Apps: Apple Music and Spotify (controlled via AppleScript)
- Behavior: Pause on start of manual/VAD recording; resume on stop/cancel (manual) and stop (VAD). Resume only the players that were previously playing.

UX
- Settings (macOS desktop only): "Auto‑pause media during recording". Default on. Hidden on non‑macOS.

Implementation
- Settings: add `system.autoPauseMediaDuringRecording: boolean` (default true)
- Desktop check: gate by `window.__TAURI_INTERNALS__` and `IS_MACOS`
- Tauri (Rust): new commands
  - `macos_pause_active_media` → detects Music/Spotify; pauses any that are currently playing; returns list of paused players
  - `macos_resume_media(players: string[])` → resumes only provided players
- Frontend query module `media`:
  - `pauseIfEnabled` executes pause command if setting enabled + macOS desktop; stores paused players
  - `resumePaused` resumes previously paused players; clears state; safe to call when none
- Lifecycle wiring:
  - Manual: pause before `recorder.startRecording`; resume after `processRecordingPipeline` completes; resume on cancel
  - VAD: pause before `vadRecorder.startActiveListening`; resume on `stopVadRecording`
- Error handling: Best-effort; failures should not block recording or result delivery

QA
- Music playing → start → pauses; stop → resumes
- Spotify playing → start → pauses; stop → resumes
- Both playing → both paused/resumed
- Neither playing → no-op
- Cancel mid-recording → resumes
- Setting off → no pause/resume
- Non-macOS → option hidden; no changes

Future
- Consider browser players via media key events or Now Playing API
- Windows/Linux support via platform-specific integrations

Review
- Added macOS-only setting and UI
- Implemented Tauri AppleScript bridge for Music/Spotify pause/play
- Wired into manual and VAD flows to pause on start and resume on stop/cancel
 - Known limitations: only Music and Spotify supported; browser players are not handled; best-effort AppleScript calls may fail silently; no Windows/Linux support yet.

