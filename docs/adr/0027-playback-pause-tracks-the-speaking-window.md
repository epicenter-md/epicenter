# 0027. Playback pause tracks the speaking window; VAD pauses per utterance

- **Status:** Superseded
- **Date:** 2026-06-18
- **Superseded by:** [ADR-0119](0119-whispering-does-not-control-system-media-playback.md)

## Context

[ADR-0017](0017-pause-system-media-playback-while-recording.md) decided that
Whispering pauses system media while recording, and that VAD pauses for the
**whole armed listening session** (pause on arm, resume on disarm). It rejected
per-utterance VAD pausing on a capture-quality argument: background audio
degrades VAD detection, so pausing only during detected speech is too late.

That framing assumed the feature exists to keep the *recording* clean (the mic
must not hear the music). But the user-held reason is different and simpler:
**hearing music while you talk disrupts dictation.** That is a courtesy concern,
not a capture concern, and it implies headphones (you hear your own music). On
headphones the recording is already clean (the mic never hears the music), so
ADR-0017's capture-quality rationale does not apply, and its degradation
objection dissolves: VAD detection is clean because the mic hears no music.

Under arm-time pausing, an always-armed "listen from anywhere" VAD session keeps
your music dead for its entire duration, including the long idle gaps between
dictations. That violates the actual invariant, which only asks for silence
*while speaking*.

## Decision

Pause playback only while the user's voice is being captured (the **speaking
window**), and derive the per-mode behavior from that one rule:

- **Manual** (press-to-talk): the whole press -> release hold *is* the speaking
  window. Pause for the whole recording. **Unchanged from ADR-0017.**
- **VAD**: the speaking window is each **detected utterance**. Pause on
  `onSpeechStart`, resume on `onSpeechEnd`. The arm-time pause is removed.

Resume after speech end is **debounced** (~1.5 s) so back-to-back utterances do
not flutter the music; the next `onSpeechStart` cancels the pending resume, a
misfire schedules it, and ending the session (disarm, stop, or starting a manual
recording) resumes immediately and drops the debounce. The debounce timer is
owned by the VAD coupling in `operations/recording.ts`, not by the playback
chain in `operations/media.ts`, which stays a dumb serialized pause/resume chain
so manual keeps its immediate resume.

ADR-0017's cross-platform machinery is unchanged: the `pause_playback` /
`resume_playback` command pair, the opaque session tokens, the per-OS modules,
and the "only resume what we paused" invariant all stand. Only the *when* for
VAD changes.

## Consequences

- The always-armed VAD workflow keeps playing music except while you actually
  speak, which is the behavior the invariant asks for.
- **Accepted limitation: VAD on speakers degrades.** With music on speakers the
  mic hears it during the armed-idle gaps, so (a) VAD onset detection is worse
  and (b) the first ~200 ms of each utterance plays over the music before the
  async pause lands. This is the exact case ADR-0017 protected and we are
  trading it away. We assume headphones (the invariant's premise) and **do not**
  detect output routing: auto-detecting headphone-vs-speaker to branch behavior
  re-introduces the two behaviors this collapse removed and is fragile across
  OSes. The quick-toggle popover and the Settings switch are the escape hatch
  for anyone who wants playback left alone.
- Manual recording is untouched, so the press-to-talk experience is identical.

## Considered alternatives

- **Keep arm-time pausing (ADR-0017 as written).** Correct for VAD on speakers,
  but it kills music for the whole armed session, which is the wart the invariant
  rejects. Chosen against because the held reason is courtesy on headphones, not
  capture on speakers.
- **Detect headphones vs speakers and branch.** Would let speakers keep
  arm-time and headphones get per-utterance, but it un-collapses the design back
  into two behaviors and depends on fragile, OS-specific output-routing reads.
  Refused.
- **Duck (lower) volume instead of pausing.** Gentler, but the system media APIs
  (MediaRemote / GSMTC / MPRIS) expose pause, not per-session volume, and ducking
  does not actually clean a speaker recording. Out of scope.
- **No debounce (resume immediately on speech end).** Flutters the music on
  every pause between phrases. The debounce is the cheap fix.

This revises ADR-0017's VAD-timing decision; that ADR otherwise stands.
