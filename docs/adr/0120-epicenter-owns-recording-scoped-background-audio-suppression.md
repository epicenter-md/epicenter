# 0120. Epicenter owns recording-scoped background audio suppression

- **Status:** Accepted
- **Date:** 2026-07-10
- **Supersedes:** [ADR-0119](0119-whispering-does-not-control-system-media-playback.md)

## Context

Whispering benefits from quieting competing audio during dictation, but direct
pause, play, volume, and mute commands would turn every embedded app into a
system-media remote. The deleted controller also returned platform session
identifiers to the webview and implied a stronger restoration guarantee than
macOS can provide through its untargeted private MediaRemote commands.

The product promise is narrower: while Epicenter remains alive, it may suppress
background audio for the lifetime of a recording and then make a best-effort
attempt to restore the playback it changed. Quitting Epicenter forgets the
in-memory epoch; the operating system remains the durable owner of media state.

## Decision

Epicenter's native recorder owns background-audio suppression as recording
startup policy. Whispering passes the selected mode into `start_recording`;
there is no separately callable begin or end operation. Rust starts suppression
only after the recording starts, then restores it on stop, cancel, close,
supersession, or process exit. A webview reload reconnects to the native
recording without reacquiring anything. Platform identities and restoration
state never cross IPC.

The user chooses one `recording.playbackSuppression` policy: `off`, `duck`,
`mute`, or `pause`. It defaults to `off`, making system playback changes
explicitly opt in. There is no numeric volume level or app-callable pause,
play, mute, unmute, increase, or decrease operation; the selected policy is
captured when recording starts. Browser Whispering may display and sync the
preference, but only Epicenter's native recorder acts on it.

*Amended 2026-07-11: the persisted key was renamed from
`recording.backgroundAudioSuppression` ("background audio" read as microphone
noise suppression) while the branch was unshipped and the rename was free.*

- Duck and mute use guarded output state: Core Audio's default output device on
  macOS, the default Windows audio endpoint, and writable volume on active
  MPRIS players on Linux. Duck never raises an already-quieter source. Restore
  occurs only while the same target still equals what Epicenter applied.
- Pause uses exact GSMTC session objects on Windows and MPRIS names plus unique
  D-Bus owners on Linux. It resumes only retained sessions that still report
  paused.
- Pause on macOS dynamically resolves the private MediaRemote framework and
  sends dedicated Pause and Play commands. It is explicitly experimental and
  best effort because macOS does not expose the exact now-playing identity to a
  third-party app. A missing framework, symbol, or rejected command is a no-op;
  restoration can affect whichever media owns the now-playing session then.

Suppression is best effort and never makes recording fail. Epicenter also
attempts restoration when its native process exits.

## Consequences

- The recorder describes one lifecycle promise instead of exposing ambient
  system controls or a standalone suppression capability.
- A volume increase or unmute is permitted only as guarded restoration of
  Epicenter's own earlier change.
- macOS private MediaRemote use is isolated to the explicitly selected
  experimental pause policy and is dynamically resolved, never hard-linked.
- Linux and Windows retain process-local session identities. They deliberately
  refuse a durable recovery protocol: keeping a general media remote or
  repairing playback on a future launch would cost more complexity than this
  convenience earns.
- The fixed duck target refuses a volume slider. Epicenter currently hosts
  manual capture; VAD suppression can be designed when Epicenter hosts VAD.
- Browser Whispering can sync the preference but cannot suppress system audio.
