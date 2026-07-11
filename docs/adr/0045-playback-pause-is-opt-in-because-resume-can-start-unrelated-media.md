# 0045. Playback pause ships opt-in because macOS resume can start unrelated media

- **Status:** Superseded
- **Date:** 2026-06-20
- **Superseded by:** [ADR-0119](0119-whispering-does-not-control-system-media-playback.md)

## Context

[ADR-0017](0017-pause-system-media-playback-while-recording.md) shipped
`recording.pausePlayback` off by default; a later change (`e3c4b1920`) flipped it
on by default on a least-astonishment argument, without an ADR.
[ADR-0018](0018-macos-resume-is-gated-on-a-coreaudio-output-read.md) justified
the on-by-default macOS resume by claiming "the worst realistic outcome is a
no-op (Play to an already-playing app) rather than a surprise start, which the
pause-time gate forecloses." That claim assumes the app the CoreAudio gate
observed is the app MediaRemote's Play will reach. It is not: the gate measures
*any* process producing output audio (`kAudioProcessPropertyIsRunningOutput`),
while MediaRemote's Play is **single-target**, aimed at whatever the OS last
marked now-playing. When those differ (a browser tab, a game, or even a
notification arms the gate while Music or Spotify sits paused as the now-playing
app), the resume wakes the paused app and starts media the user never had
playing. The gate does not foreclose this; it only forecloses resuming from total
silence. Windows (GSMTC by AUMID) and Linux (MPRIS by bus name) resume the exact
sessions they paused, so this is macOS-only.

## Decision

`recording.pausePlayback` ships **off by default**. A best-effort convenience
that can occasionally start unrelated media must be chosen, not sprung. The
settings toggle's description and the home-row quick toggle explain the behavior
at the moment the user turns it on, which is the consent point an opt-in feature
needs, so the first-pause explanatory toast (and its
`notices.pausePlaybackExplained` device-config flag) are deleted: their only job
was after-the-fact consent for an on-by-default feature. The toggle copy is also
corrected from "resume it" to "try to resume it," and the Settings copy names the
macOS caveat outright.

The pause/resume machinery, the CoreAudio gate of ADR-0018, and the
speaking-window timing of [ADR-0027](0027-playback-pause-tracks-the-speaking-window.md)
are unchanged. Only the default and the framing change.

## Consequences

- No user gets surprise playback they never enabled; the macOS contamination case
  can only reach someone who deliberately opted in and read the caveat.
- The happy-path majority who would have benefited from auto-pause now have to
  discover and enable it. Accepted: the home quick toggle and Settings switch
  make that one tap, and the cost of a wrong-default surprise in a tool whose
  value is being unobtrusive outweighs the convenience of a right-default guess.
- This corrects ADR-0018's "worst case is a no-op" consequence; that ADR's
  decision (gate resume on a CoreAudio read rather than the perl shim) still
  stands, and the contamination is the residual cost the opt-in default absorbs.
- A precise macOS resume would need the now-playing read, which 15.4
  entitlement-gated; the `ungive/mediaremote-adapter` shim restores it but was
  rejected in ADR-0018 as disproportionate, and remains so for a convenience
  feature.

## Considered alternatives

- **Keep on by default (status quo).** Springs surprise media on users who never
  asked, in the exact tool that should be unobtrusive. Rejected.
- **Pause only, never resume.** Removes contamination but discards the most
  useful half of the feature. Rejected; opt-in keeps resume for those who want it.
- **Bundle `ungive/mediaremote-adapter` for an identity-matched resume.** Already
  rejected in ADR-0018; a perl + private-framework sidecar is wildly out of
  proportion to a best-effort convenience.
