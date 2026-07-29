# 0023. Whispering separates its identity mark from Lucide controls

- **Status:** Accepted
- **Date:** 2026-06-16

## Context

One Lucide `Mic` glyph carries three jobs at once: the brand mark in the
sidebar, the manual recording-mode icon, and the idle record button. A new user
cannot tell whether the mic means "this app," "this mode," or "press to record,"
because it means all three. The app also runs three icon vocabularies in
parallel: Lucide in the UI, emoji in constant tables (`RECORDING_MODE_OPTIONS.icon`,
plus the never-rendered `RECORDER_STATE_TO_ICON` and `VAD_STATE_TO_ICON`), and
emoji-bitmap PNGs in the tray (`studio_microphone.png` and siblings, named after
emoji shortcodes). The menubar and the app therefore disagree on what a
microphone looks like, personality is scattered across three systems, and the
brand is the same drawing as the button.

## Decision

Whispering's iconography is two tiers, and the tiers never share a drawing.

Tier 1 is identity: a single studio-microphone image that gives the app a face.
It is a temporary placeholder, not owned artwork. The image is vendor emoji art
(sourced from emoji.aranja.com, an Apple-style emoji rendering) with no clear
license to call our own, so this ADR does not claim it as an owned mark. It may
ship only as a bounded placeholder on current product surfaces: the home hero,
the sidebar brand, the tray idle icon, and the current landing brand surfaces.
Product/legal sign-off, or replacement with owned or permissively licensed art,
is required before broader brand use, app-store marketing expansion, paid
promotion, merchandise, or treating the drawing as Whispering's permanent mark.
Consolidating the per-surface asset copies would make the pipeline honest; it
would not solve this licensing risk by itself. The studio mic reads as a brand object rather than another
control, which is why it remains the placeholder until owned art exists. It is
decorative and static; it does not state-switch. The brand mark is never the
same glyph as the action.

Tier 2 is control: Lucide everywhere, state-driven, deliberately quiet. Manual
is `Mic` and `Square` (recording), voice-activated is a listening glyph and
`AudioLines` (speech detected), and file import stays outside the recording
trigger model. One resolver owns the recording state-to-glyph mapping; render
sites own their own sizing and chrome.

Emoji appear only as voice in prose (the `❤️` in "Free and open source ❤️"),
never as functional iconography. Web UI never reaches into `src-tauri` for an
image, so the shared studio-mic image is given a frontend home
(`src/lib/assets/studio-microphone.png`) and rendered as a decorative `<img>`;
the tray keeps its own copy under `src-tauri/recorder-state-icons/` loaded via
`resolveResource`. The two runtime paths stay separate on purpose (the web
bundles a hashed asset; the native tray reads a file off disk).

## Consequences

- The brand is legible as the brand. The sidebar mark stops being the action
  glyph, so "this app" and "press to record" read as different things.
- The menubar and the home screen are the same object: the same studio-mic image
  drives the hero, the sidebar brand, and the tray idle icon.
- The dead emoji state tables are deleted, trigger options use Lucide icons, and
  the recording-button tables own state-to-glyph mapping, so there is one
  functional glyph owner instead of two that disagree.
- Personality concentrates in two deliberate places (the Tier-1 image and the
  recording-state motion) rather than diluting across emoji, PNG, and glyph
  reuse. Everything functional is disciplined Lucide.
- The Tier-1 image is a pragmatic placeholder, not owned art. The tier
  *structure* is the durable decision; the specific image is replaceable.
  Shipping this PR does not clear the asset for broader brand use. That requires
  product/legal sign-off or replacement with owned or permissively licensed art.

## Considered alternatives

- **Hand-author an owned SVG mark now.** Tried and rejected: the drawing looked
  amateur beside the flat Lucide/shadcn UI. Deferred to a future owned redraw;
  the pragmatic studio-mic image ships in the meantime. This is the path back to
  a truly owned mark when good art exists.
- **Pure Lucide everywhere, no identity tier.** Rejected: a thin line mic on the
  hero is anemic and the app loses its personality. Lucide is right for controls,
  not for the one place the brand should have character.
- **One glyph for brand and action, as today.** Rejected: it is the root
  confusion this ADR removes.
- **Unify the tray and web mark into one physical source file.** Deferred, not
  refused. The two are byte-identical today, so two copies look redundant, and
  Tauri's `bundle > resources` map form could bundle the single frontend image
  into the tray's resource path. But the surfaces have different rendering
  destinies: the tray icon wants menubar legibility and, on macOS, a monochrome
  template image, at which point the tray asset diverges from the full-color web
  mark. Unifying now would have to be undone then. Kept as two copies until that
  divergence is real. The tray resources are declared in
  `bundle > resources`, so `resolveResource` has packaged-build files to read;
  the remaining open question is source ownership, not bundling.
