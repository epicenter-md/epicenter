# 0018. macOS resume is gated on a CoreAudio output read, not a MediaRemote read shim

- **Status:** Superseded
- **Date:** 2026-06-16
- **Superseded by:** [ADR-0119](0119-whispering-does-not-control-system-media-playback.md)

## Context

[ADR-0017](0017-pause-system-media-playback-while-recording.md) pauses and
resumes system media playback by sending MediaRemote commands. Sending survives
on macOS, but macOS 15.4 entitlement-gated the now-playing **read** to Apple
(`com.apple.*`) bundle ids: a notarized Developer-ID app cannot read what (or
whether anything) is playing, and the gate is all-or-nothing (even the bare
now-playing PID read is closed). A safe resume needs that read. Without it, a
blind Play-on-stop would restart media the user had already paused themselves,
because we couldn't tell anything was playing when we sent pause.

## Decision

Gate macOS resume on a **CoreAudio output-activity read**, not on MediaRemote's
gated read. CoreAudio's process-object list
(`kAudioHardwarePropertyProcessObjectList` + per-process
`kAudioProcessPropertyIsRunningOutput` / `BundleID`) is a public API, needs no
TCC permission (we enumerate processes, never tap their samples), and is
hard-linked. On pause we record the bundle ids genuinely producing output audio
and **arm resume only when that set is non-empty**; resume then sends
MediaRemote's single-target Play. So we never restart something that was not
playing. On macOS before 14.4 (when the process-object API arrived) the read is
unavailable, the set stays empty, and the feature degrades to pause-only, which
is the same safe floor macOS shipped before resume existed.

## Consequences

- macOS gains auto-resume without bundling any private framework, spawning any
  subprocess, or taking any notarization risk.
- The resume is a **heuristic, not an identity match**: `IsRunningOutput` is IO
  registration, and MediaRemote's Play is single-target. We accept that the
  worst realistic outcome is a no-op (Play to an already-playing app) rather than
  a surprise start, which the pause-time gate forecloses.
- macOS pause/resume is now consistent with Windows/Linux in the settings copy
  ("resumes it when you stop"), so no softening was needed.
- We are tied to CoreAudio's process-enumeration API staying public; if it
  closed, macOS would fall back to pause-only with no behavior change to the
  command path.

## Considered alternatives

- **Blind Play(0) on stop.** No read means it can restart media the user had
  already paused (the one genuinely bad surprise). Rejected; the CoreAudio gate
  exists specifically to prevent it.
- **The `ungive/mediaremote-adapter` perl + framework read shim** (the spec's
  original Wave 5 for a true identity-matched resume). It gets full now-playing
  identity by loading a bundled framework inside Apple-signed `/usr/bin/perl`.
  Rejected: it bundles + deep-signs a private-framework binary, carries known
  Tauri sidecar notarization friction (tauri#11992), needs a supervised
  long-lived subprocess, and depends on a private-framework workaround Apple has
  already shown it will close, all for precision the CoreAudio gate's coarse read
  does not need.

*Revisit trigger: if Apple reopens the MediaRemote read, or closes the CoreAudio
process-enumeration API, reweigh the shim against pause-only.*

Deferred fast-follow (not built): a one-time contextual "Something's playing,
pause it?" prompt on first record-while-playing, with "Always pause" flipping
`recording.pausePlayback`. Deep evidence lived in
<!-- doc-path-check: ignore-next-line -->
`apps/whispering/specs/20260616T180000-pause-playback-while-recording.md`
(deleted; recover via `git log --all --full-history`).
