# Honeycrisp App

Local-first notes SPA over `so.epicenter.honeycrisp`: folders and notes as
scalar rows, each note body a row-owned Yjs document.

Design authority: [ADR-0190](../../docs/adr/0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md) (which Epicenter owns a build's data is a build-time declaration), [ADR-0177](../../docs/adr/0177-a-browser-replica-is-owned-by-a-storage-partition-and-origin-pair.md) (a WebView is a storage partition and origin pair like any other), [ADR-0168](../../docs/adr/0168-lenses-are-complete-pure-json-interpretations.md) (Epicenter Home keeps its own release-local interpretation of this namespace).

## Three builds, one SPA

| Build | Command | Replica |
|---|---|---|
| Web | `bun run build` | this origin's own, plus its own sync |
| Standalone desktop | `bun run tauri build` | its WebView's own |
| Epicenter-hosted | `bun run build:epicenter` | the desktop host's shared `epicenter.sqlite3` |

Only the third differs, and it says so with the `epicenter-host` resolve
condition rather than `tauri`: the standalone bundle is a Tauri WebView that
owns its own storage, so those two are separate facts here. Load
`workspace-app-composition` before touching a `#platform/*` seam.

Dropping a host leaf from a seam fails no build. Resolution falls back to the
browser leaf and the hosted build silently keeps notes where nothing else can
read them. Two tests catch that: `src/lib/platform-selection.test.ts` reads the
declarations and names the broken seam, and
`../epicenter/scripts/build-applications.test.ts` runs the real build and reads
the emitted bytes. `typecheck` runs all three conditions; only the default one
is checked by an editor.

## Don'ts

- Do not detect the host at runtime. The build already answered.
- Do not migrate, import, or delete data belonging to another build. The
  standalone bundle and the hosted build are two databases on one machine, and
  nothing moves between them.
- Do not import Honeycrisp's Lens into the Epicenter host's own code. Home keeps
  a deliberately separate release-local interpretation (ADR-0168); only the
  cross-Lens journey test compares them.
