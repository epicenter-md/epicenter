# 0120. Epicenter owns recording-scoped background audio suppression

- **Status:** Accepted
- **Date:** 2026-07-10
- **Supersedes:** [ADR-0119](0119-whispering-does-not-control-system-media-playback.md)

## Context

Whispering benefits from quieting competing audio during dictation, but direct
pause, play, volume, and mute commands would turn every embedded app into a
system-media remote. The deleted controller also returned platform session
identifiers to the webview, and macOS restoration used an untargeted private
MediaRemote play command that could start unrelated playback.

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

The user chooses one boolean behavior, `recording.suppressBackgroundAudio`.
There is no volume level, platform mode, or app-callable pause, play, mute,
unmute, increase, or decrease operation.

- macOS uses public Core Audio to lower the current default output device to a
  fixed target. It never raises an already-quieter device. Restoration occurs
  only on the same device and only while its current value still matches what
  Epicenter applied, preserving user changes made during recording.
- Linux pauses active MPRIS players and remembers their instance-qualified bus
  names. It resumes only remembered, still-present players that report paused.
- Windows pauses active GSMTC sessions and retains the exact WinRT session
  objects that accepted pause. It resumes only those retained sessions while
  they still report paused.

Suppression is best effort and never makes recording fail. Epicenter also
attempts restoration when its native process exits.

## Consequences

- The capability describes one lifecycle promise instead of exposing ambient
  system controls.
- A volume increase is permitted only as guarded restoration of Epicenter's own
  earlier reduction.
- macOS no longer depends on private MediaRemote behavior or an auxiliary
  daemon.
- Linux and Windows retain process-local session identities. They deliberately
  refuse a durable recovery protocol: keeping a general media remote or
  repairing playback on a future launch would cost more complexity than this
  convenience earns.
- Fixed automatic behavior refuses a cross-platform strategy matrix, volume
  slider, and VAD debounce machinery. Epicenter currently hosts manual capture;
  VAD suppression can be designed when Epicenter hosts VAD.
- Browser Whispering can sync the preference but cannot suppress system audio.
