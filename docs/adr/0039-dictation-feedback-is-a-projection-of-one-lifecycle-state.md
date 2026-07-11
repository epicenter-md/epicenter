# 0039. Dictation feedback is a projection of one lifecycle state, not an event log

- **Status:** Accepted
- **Date:** 2026-06-18
- **Amended by:** [ADR-0040](0040-a-cursor-write-that-cannot-paste-falls-back-to-the-clipboard-decided-from-the-grant.md) — the delivery reach below collapsed from three rungs (`output`/`clipboard`/`history`) to two (`output`/`clipboard`); a cursor write that cannot paste now leaves the transcript on the clipboard instead of stranding it in history.

## Context

A dictation moves through one sequence of phases (recording, transcribing,
delivered or failed), but the app reports it through two unrelated mechanisms.
The floating pill (`recording-pill/`) is a projection of recorder state: one
self-replacing value, the correct shape. The toasts are fired imperatively, step
by step, from `operations/recording.ts` and `operations/pipeline.ts`
("Stopping..." then "Recording stopped" then "Transcribing..." then a success
notice), so a single thing moving through four phases reads as a four-line append
log. Toasts are also doing duty as an informal failure record even though every
failed dictation already persists as a recording row. The pill only represents
`RECORDING` and VAD states today; transcription and failure feedback live
entirely in toasts. With the pill now carrying glanceable in-flight status on
desktop, the per-step toast sequence is redundant noise, and on web (no pill) it
is still the only feedback, so the two platforms have drifted into two models.

## Decision

Dictation feedback derives from one lifecycle value owned by the main window,
modeled as two orthogonal tracks: **capture** (`idle | recording-manual |
listening | speaking`, the live session, derived from the recorder machines) and
**outcome** (`none | transcribing | delivered | failed`, the most-recent
utterance's pipeline result, where `delivered` carries a *reach*: landed at the
configured output, or fell back to the clipboard — ADR-0040 collapsed the former
history-only rung). Every
surface is a pure projection, never an
imperative emission. The two tracks exist because voice-activated capture is
*continuous*: an utterance transcribes while the session keeps listening, so
capture and outcome run concurrently. Manual capture is sequential, so its two
tracks never overlap and it reads as one linear phase sequence.

Outcome is most-recent-wins, which suits both the OS-notification path (each
distinct failure notifies once) and the pill: a failure is a transient glance,
not a held state. The pill is not a review surface, so there is no failure latch.
A failure that scrolls past on the live pill is still caught by the OS
notification (which fires on every failure) and the recordings row, which is the
durable log and the home of retry.

- The **pill is the status surface.** It projects the pair. When capture is idle
  (manual after stop, or a VAD session after disarm) the outcome is the pill's
  primary content: a transcribing indicator, a sub-second delivered flash, or a
  glanceable failed state (the terse reason, no action). While VAD capture is
  live, the listening meter is the primary content and the previous utterance's
  transcribe rides alongside it as a small secondary spinner pip, cleared when it
  lands (the delivered text is the receipt, so a continuous session shows no
  per-utterance success flash). A VAD failure earns no pip: it is not shown on the
  live pill at all, only on the OS notification and the recordings row. Manual
  keeps the full linear flow unchanged. It is the same Svelte component on both
  platforms; the Tauri build mounts it in a native always-on-top window driven
  over IPC, the web build mounts it as a fixed in-page element driven directly.
  Style, icons, and states are identical by construction; only mount target and
  wiring differ.
- The **tray icon is the menubar projection.** On desktop the tray reflects the
  same lifecycle at the coarsest grain: active whenever a capture is live, manual
  or VAD, and idle otherwise. It carries no in-flight or terminal phase (those are
  the pill's); it is the always-present ambient cue, robust where the
  always-on-top pill is weaker (Windows/Linux, occlusion, another Space). It reads
  the lifecycle, not the manual recorder alone, so it never sits on the idle icon
  through a VAD session the pill is already showing.
- The **happy path emits no toast.** Success is the output: the transcribed text
  landing in the clipboard or cursor is the receipt. The delivered flash plus the
  existing opt-in completion sound are the only success feedback.
- **Failure means no usable text; only two tiers qualify.** Silent-loss failures
  (recording never started: no mic, denied permission) are the loudest, because
  the user is talking into nothing and there is no artifact to recover. A failed
  transcription keeps the audio safe in the recordings list, so its row carries
  the retry; the pill only glances that it failed. A transcript that was produced
  but missed its
  configured output (paste or injection failed) is **not** a failure: the text is
  saved, so it is a reduced *delivery reach*, not a tier. It rides on the
  `delivered` outcome (a clean `output`, or a `clipboard` fallback; see ADR-0040)
  and shows an amber tag, never a red pill and never an OS notification.
  Folding delivery into the reach axis keeps failure clean: a missed delivery is a
  reduced success, not a failure, so the failure path carries only the two real
  tiers. Every real failure fires the OS notification (`report/index.ts`), focused
  or not: VAD runs unattended and shows nothing on the live pill, so a focused user
  watching the listening meter would otherwise get no signal that an utterance was
  lost. A failure notification is the non-annoying kind (success and progress
  toasts are already gone), so it is a worthwhile floor, not noise. The exception
  projection reads the **outcome** track directly, so a VAD utterance that fails
  mid-session still notifies even though the live meter is what the pill is
  showing.
- **A clean delivery flashes; a reduced reach persists.** The clean `output` reach
  flashes for a beat and retires, because the landing text is the receipt and the
  pill is just a glance. The reduced `clipboard` reach instead stays
  on the pill until the next dictation, the way a failure glance does: the text did
  not land where the user asked, so the tag carries information the text alone does
  not, and a sub-second flash is too easy to miss. A reduced reach is still not a
  failure and fires no notification: the persistent pill tag and the recordings row
  are enough, and the dominant cause, a revoked Accessibility grant
  (cursor paste-back is guarded by the paste grant watcher), already raises its
  own standing notice. Under ADR-0040 a paste that cannot land falls back to the
  clipboard rather than stranding the transcript, so the reduced reach is always
  recoverable with one ⌘V.
- **The dictation path emits no toasts.** The pill glances the status, the OS
  notification is the cross-app failure alert, and the recordings row is the
  failure-detail surface and the home of retry. There is no toast in the dictation
  loop and no `MoreDetailsDialog` step: failure detail lives on the row that holds
  the audio. Toasts survive only for non-dictation app messages outside this
  decision's scope.
- The **recordings list is the only failure log.** A failed dictation is a
  durable recording row, not an ephemeral event. Transient surfaces point at that
  row; they do not store a parallel copy. There is no separate notification
  center or failure-log popover.
- **Standing-condition warnings are not failures.** A revoked or stale
  Accessibility grant, or a disconnected mic, is a present condition that
  self-clears, owned by the pill's degraded state and the existing dedup-by-id
  `report.warning`, not the per-event lifecycle.
- **A few adjacent notices stay toasts.** A device-fallback notice ("switched to
  an available microphone"), a missing-transformation notice (the selected
  transformation was deleted), and a cancel-operation failure all fire from the
  dictation operations but are config or operation conditions with no
  capture/outcome phase, so the pill cannot carry them and they keep `report.*`.
  The no-toast rule governs dictation lifecycle feedback, not every notice that
  happens to originate in `recording.ts` or `pipeline.ts`.

## Consequences

- The per-step toast sequence is deleted on every platform, and the toast leaves
  the dictation path entirely. The happy path is silent; the pill plus the output
  carry it. The `report.error` / `MoreDetailsDialog` failure-detail wiring is
  removed from the dictation flow, replaced by the OS notification plus the
  recordings row, which already owns retry.
- The browser stops being a second model. `RecordingPillHost` reads the shared
  lifecycle directly and mounts the shared pill; only the Tauri runtime owner
  synchronizes a projected status through `recording-overlay/` transport into a
  separate webview. Desktop and web are identical by construction rather than
  kept in sync by discipline.
- One value has one set of consumers, so "what is my dictation doing" and "what
  failed" each have exactly one home (the pill, the recordings list). Toasts stop
  being an accidental, reload-losing log.
- A VAD failure is not shown on the live pill, so a focused user learns of it from
  the OS notification (which always fires) and the recordings row, not the pill.
  This is the deliberate trade: the pill is a live glance, not a failure queue, and
  the recordings list is the durable, searchable record. Capture and outcome no longer
  compete for the pill, so the live meter and the in-flight spinner pip render at
  once instead of one masking the other.
- Cost: extending the pill to terminal phases adds timed transitions (the
  delivered flash auto-hides; the failed state persists until the next dictation),
  which the current RECORDING-only pill did not have.
- We forgo any always-available activity feed. If one is ever justified it must be
  a filtered view of the recordings table, never a parallel store.

## Considered alternatives

- **A dedicated failure-log popover (bottom-right notification center).** Lost
  because it duplicates the recordings list, which is durable, searchable, holds
  the audio, and survives reload, while the popover would be a transient, worse
  copy built as standing infrastructure for a rare event.
- **Keep success toasts for explicit confirmation.** Lost because the output is
  the confirmation; a toast announcing text the user is already watching appear is
  pure redundancy. A single opt-in setting can restore a success toast for the
  minority who want one.
- **Pill on desktop only, toasts remain the web model.** Lost because it freezes
  the two-model drift in place; sharing one component collapses the
  per-platform conditional instead of tuning it.
- **Keep a focused-window failure toast with inline Retry.** Lost because the
  recordings row already holds the failure and its retry, so a focused toast is a
  redundant, transient copy; when unfocused the toast is in a window the user is
  not looking at, so it is useless. The OS notification covers the unfocused case
  cross-app where a toast cannot, and the recordings row is the durable detail.
- **Collapse the two tracks into one most-recent-wins value.** Lost because a
  live capture would mask the in-flight outcome: a continuous VAD session would
  show either the listening meter or the previous utterance's transcribe spinner,
  never both, and the notification path (which reads outcome) would lose the
  signal. Capture and outcome are concurrent in voice activation, so they stay two
  tracks. (Failure is the one outcome deliberately kept off the live pill: it is
  an event for the notification and the recordings row, not a held pill state.)
- **Latch a failure on the live pill until the user reviews it.** Lost as
  accidental complexity. The latch existed only to keep a VAD failure visible
  against most-recent-wins, but the recordings row already keeps every failure
  durably and the OS notification fires the unfocused case, so the latch bought a
  live glance the user did not need ("I will check it later"). Removing it deletes
  a held third fact, a cross-file guard, the pill's red failure pip, and the
  pill-to-row review path, and moves retry to the recordings row alone.
- **Show a per-utterance delivered flash in VAD too (symmetric with manual).**
  Lost because in continuous dictation the landing text is the receipt, and a
  green flash every few seconds reads as nagging. Comparable continuous-dictation
  apps (superwhisper, live-caption tools) surface processing and errors but not
  per-utterance success. In VAD, success earns no pixels; only in-flight and
  failure do.
