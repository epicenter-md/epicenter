# 0119. Whispering does not control system media playback

- **Status:** Accepted
- **Date:** 2026-07-10
- **Supersedes:** [ADR-0017](0017-pause-system-media-playback-while-recording.md), [ADR-0018](0018-macos-resume-is-gated-on-a-coreaudio-output-read.md), [ADR-0027](0027-playback-pause-tracks-the-speaking-window.md), [ADR-0045](0045-playback-pause-is-opt-in-because-resume-can-start-unrelated-media.md)

## Context

Pausing media during dictation required three operating-system controllers,
session-token bookkeeping, timing policy for manual and voice-activated
recording, settings, and recovery behavior. macOS could not reliably resume the
same media it paused, so even the opt-in version could start unrelated playback.
This machinery was disproportionate to a courtesy feature outside Whispering's
core recording and transcription promise.

## Decision

Whispering does not inspect, pause, or resume system media sessions. Recording
starts without modifying other applications. We delete the setting, lifecycle
hooks, native controllers, IPC contract, and compatibility surface instead of
preserving a dormant or platform-partial implementation.

## Consequences

- Users pause background playback themselves when they want silence.
- Recording lifecycle has no cross-application media state or recovery path.
- Epicenter exposes no system-media capability on Whispering's behalf.
- A future media-control feature must earn a new product promise and a reliable
  cross-platform ownership model; it does not revive these APIs by default.
