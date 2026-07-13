# 0017. Whispering pauses system media playback while recording through one cross-platform controller

- **Status:** Superseded
- **Date:** 2026-06-16
- **Superseded by:** [ADR-0119](0119-whispering-does-not-control-system-media-playback.md)

## Context

Background audio (music, a video, a browser tab) contaminates a recording's
capture quality. The shipped feature pulled the wrong levers: it AppleScripted
exactly two named apps (Music, Spotify), was gated to macOS only, and lived in
the `sound.*` settings group beside the beep-on-start toggles it has nothing to
do with. The largest contamination source for a transcription app, browser /
YouTube / web audio, was never covered. Every desktop OS exposes a system
media-session layer with a real, dedicated pause command and a per-session
playing-state query, so the capability exists uniformly; we were not using it.

## Decision

Pause **system media sessions**, not app-specific integrations. One Rust `media`
module exposes a single Tauri command pair, `pause_playback() ->
Vec<String>` / `resume_playback(Vec<String>)`, dispatching to one `cfg`-gated
impl per OS: Windows GSMTC (`Windows.Media.Control`), Linux MPRIS over session
D-Bus (`zbus` v5, hand-rolled), macOS MediaRemote (`MRMediaRemoteSendCommand`,
resolved by `dlopen` not link). The recording lifecycle
(`operations/recording.ts`) is the only caller, and it stays fire-and-forget:
recording never waits on, and never fails because of, playback control.

The element crossing IPC is an **opaque `PausedSession` string token** (macOS
bundle id, Windows AUMID, Linux MPRIS bus name); the frontend never interprets
it, only round-trips it from `pause` back to `resume`. The frontend serializes
every pause/resume onto one promise chain whose resolved value *is* the set of
tokens currently paused, so a late resume can never clobber a fresh pause from a
quick stop-then-restart. The one safety invariant: **never send play to a
session we did not personally pause.**

The setting is re-homed from `sound.pauseMediaDuringRecording` to
`recording.pausePlayback` (workspace KV, roaming; hard rename, no migration;
default off), and its switch moves to the Recording settings page with no
platform gate.

## Consequences

- Browser / YouTube / web audio is now covered on all three platforms, which is
  the dominant contamination case for a transcription app.
- Windows and Linux gain the feature they never had.
- The macOS multi-player case is an **accepted limitation**: MediaRemote is
  single-target, so when two apps play at once only the system now-playing one is
  paused/resumed. Named so no one is surprised; this is the cost of refusing the
  app-specific layer.
- The hard rename reverts anyone who had enabled the old macOS-only setting to
  the `false` default. Accepted: the old default was off and the setting was
  niche.
- macOS resume has its own fragility (no in-process now-playing read post-15.4);
  its mechanism is recorded separately in [ADR-0018](0018-macos-resume-is-gated-on-a-coreaudio-output-read.md).

## Considered alternatives

- **App-specific integrations (AppleScript Music/Spotify, Spotify Web API).**
  Can't touch the browser, the whole point. Deleted.
- **HID media-key injection (macOS F8 / `CGEventPost`).** Can't query state and
  *starts* playback when idle, violating "never start playback." Refused on all
  platforms.
- **Play/pause toggle commands** (`kMRTogglePlayPause`,
  `TryTogglePlayPauseAsync`, `PlayPause()`). Same start-when-idle hazard; we use
  the dedicated pause everywhere.
- **Splitting the setting into pause + resume toggles.** A split only earns its
  keep if auto-resume is unsafe; we made it safe (set-scoped). One toggle.
- **Per-utterance VAD pause/resume.** Churns the user's playback on every
  utterance, and background audio degrades VAD detection itself, so pausing only
  during detected speech is too late. We pause for the whole armed listening
  session instead.
- **`MPNowPlayingInfoCenter` / `souvlaki`.** These expose *your own* app's
  playback to the OS; they cannot control other apps. Wrong tool.

Deep evidence and the full interaction matrix lived in
<!-- doc-path-check: ignore-next-line -->
`apps/whispering/specs/20260616T180000-pause-playback-while-recording.md`
(deleted; recover via `git log --all --full-history`).
