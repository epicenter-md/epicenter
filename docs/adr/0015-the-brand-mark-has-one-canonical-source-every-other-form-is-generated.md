# 0015. The brand mark has one canonical source; every other form is generated

- **Status:** Superseded
- **Date:** 2026-06-17
- **Superseded by:** [ADR-0023](0023-whispering-separates-its-identity-mark-from-lucide-controls.md)

## Context

ADR 0013 made the studio mic the single identity mark, called the image a
replaceable placeholder, and promised that swapping it is "replacing one
frontend file (and the tray copy)." That promise is already false. The same mark
now exists as six-plus committed derivatives under three names: the web asset
(`apps/whispering/src/lib/assets/studio-microphone.png`), the byte-identical tray
copy (`src-tauri/recorder-state-icons/studio_microphone.png`), the higher-res
Tauri app icons (`src-tauri/icons/*`), the favicon/PWA set
(`static/favicon*`, `apple-touch-icon`, `android-chrome-*`), and a landing copy
(`apps/landing/public/studio-microphone.png`). The real source is external (a
download from emoji.aranja.com); every in-repo file is an ad-hoc derivative at
whatever size a surface happened to need. Nothing links them, the names describe
the placeholder drawing rather than the role, and changing the mark means
hand-editing many files across two apps.

## Decision

The brand mark has exactly one canonical source file, committed in a shared
location both apps consume. Every other form is a generated or imported
derivative of that source, never a hand-made copy.

- Web surfaces (Whispering hero and sidebar, landing hero and footer) import the
  canonical file directly; the landing's `public/` copy is removed in favor of
  the shared import.
- Tauri app icons are produced by `tauri icon <source>`; the favicon and PWA set
  are produced by a committed generation script. Generated outputs may be
  committed, but only as the output of a documented `source -> outputs` step,
  never edited by hand.
- The tray keeps its own on-disk file, the one place ADR 0013's runtime-
  divergence argument holds (the macOS menubar wants a monochrome template
  variant), but that file is generated from the canonical source too.
- Assets are named for their role (`whispering-mark`, `recording-indicator`),
  not for the drawing they currently contain.

The canonical source stays the ADR-0013 placeholder image for now. This ADR
does not turn that placeholder into owned art or grant brand/legal sign-off; it
only prevents the current copy-per-surface drift. Promoting the mark to an owned
vector (SVG) is the art-gated step and is deferred until owned art exists; the
pipeline is shaped so that promotion is a one-file replacement.

## Consequences

- Swapping the mark becomes the one-file change ADR 0013 promised: replace the
  source, re-run generation.
- The cross-app copy added for the landing is deleted; brand assets get a real
  home (a `packages/brand` module, or `@epicenter/ui`) instead of per-app
  `public/` directories.
- Role-based names survive art changes, so when the placeholder becomes owned art
  no file is left misnamed.
- Cost: a generation step (scripts plus a shared package) that does not exist
  today, and committed generated artifacts whose provenance now depends on
  running the script. Contributors regenerate rather than drop in a PNG.
- This does not change ADR 0013's two-tier identity-vs-control split, which
  stands. It resolves 0013's explicitly deferred questions: the duplicated
  copies, the not-owned-art placeholder, and the missing single source.

## Considered alternatives

- **Keep copy-per-surface (status quo).** Rejected: the copies have no runtime
  reason to diverge except the macOS tray template; the rest is drift waiting to
  happen, and the landing copy already proved it spreads.
- **Generate at build with no committed outputs.** Deferred: Tauri bundling and
  favicon `<link>`s expect files on disk, so committing generated outputs with a
  documented source is simpler than a mandatory pre-build hook today. Revisit if
  the outputs churn.
- **Author the owned SVG now and make it the source.** Deferred, not refused:
  ADR 0013 already rejected hand-drawn art as amateur next to the flat UI. The
  pipeline is built to accept that SVG the moment good art exists.
