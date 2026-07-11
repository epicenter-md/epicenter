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

Epicenter owns background-audio suppression behind an opaque recording-scoped
lease. Whispering passes a recording id to begin suppression and returns the
lease to end it. Reacquiring the same recording id returns the existing lease,
so a webview reload can reconnect to a native recording without creating an
orphaned suppression window. Platform identities and restoration state never
cross IPC. Overlapping leases share one suppression epoch, and only the final
lease restores it.

The user chooses one `recording.playbackSuppression` policy: `off`, `duck`,
`mute`, or `pause`. It defaults to `duck` so speaker bleed does not degrade
first-run transcriptions; `off` keeps other apps playing. There is no numeric
volume level or app-callable pause, play, mute, unmute, increase, or decrease
operation; the selected policy is captured when a lease begins. The setting
renders only in hosts that can suppress playback.

*Amended 2026-07-11: the persisted key was renamed from
`recording.backgroundAudioSuppression` ("background audio" read as microphone
noise suppression) and the default changed from `off` to `duck` while the
branch was unshipped and the rename was free.*

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

- The capability describes one lifecycle promise instead of exposing ambient
  system controls.
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
