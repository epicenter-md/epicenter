# 0267. A workspace exports and imports as a legible folder-structured artifact

- **Status:** Accepted
- **Date:** 2026-08-26
- **Supersedes:** [ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md) at the artifact representation: rich documents are legible text files through their codec, not binary `document_update_v2` updates embedded in SQLite.
- **Amends:** [ADR-0256](0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md) and [ADR-0255](0255-data-definitions-use-one-data-first-public-vocabulary.md) at the deferred Compact-workspace action: the manual reset is no longer deferred, it is this export and import.
- **Relates:** [ADR-0264](0264-a-table-declares-its-row-documents-derivation-and-file-codec.md) (the `file` codec this renders through), [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md) (the derived address the layout mirrors), [ADR-0257](0257-the-application-document-has-named-kv-and-table-roots.md) (the roots the layout mirrors), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) (the client owns its store)
- **Unbuilt:** no export or import exists in the tree; this is a greenfield build against the row-document manager.

## Context

ADR-0256 and ADR-0255 deferred a Compact-workspace reset until measured storage pressure justified it, and ADR-0167 specified a portable export as SQLite `rows`/`values` with each document embedded as an opaque binary Yjs `document_update_v2` update. This redesign has a different motivation than storage pressure and a different value: a person wants their data as legible, editable files they can read, diff, back up, and re-upload, and prefers legibility over lossless CRDT fidelity. ADR-0264 supplied the missing piece both prior records lacked, an application-owned document codec.

## Decision

A workspace exports as a folder-structured artifact and imports by replacing the workspace in place. The artifact is a directory, zipped for download:

```txt
tables.json                            scalar rows and fields, by table
kv.json                                the kv root's final state
documents/<table>/<row>.<ext>          each row document through its file codec
```

`tables.json` rather than `tables.sqlite`: the scalar rows are the truth, and a
SQLite projection is a disposable query surface rebuilt from them (ADR-0026,
ADR-0213), so the export carries the legible, editable facts and leaves the
projection to be regenerated. One file per document, not per root: a `file`
codec serializes the whole document to one string.

Export serializes each row document through its application-declared `file` codec (ADR-0264) to a legible text file at its derived address (ADR-0248). Import deserializes each file back into a document, rebuilds one envelope, and replaces the workspace's documents in place under a fresh document identity, the replace-not-merge semantics of the reset path: a stale replica supersedes rather than merges. The export is intentionally lossy, carrying current visible state rather than Yjs identity or history, because import re-mints identity. It is a manual, application-owned escape hatch with an explicit loss boundary for unsynchronized work, the shape ADR-0256 required of any Compact workspace.

The export runs client-side. The client owns its store (ADR-0227), so it serializes itself into the artifact and nothing is materialized by the host. A live, host-rendered `~/Epicenter` folder is a separate decision that reopens ADR-0226/0227 and is not part of this record.

## Consequences

- A person can read, diff, back up, and re-upload their data as markdown and SQLite, without the application.
- The export is legible but lossy: re-import is a clean-break reset, not a history-preserving restore. Offline edits absent from the export, and all CRDT history, are discarded by import, the explicit loss boundary ADR-0256 demanded.
- ADR-0167's binary `document_update_v2` form is superseded. The multi-file `documents/` tree is the inventory 0167 refused; it is accepted here because the artifact's purpose is human legibility, not a minimal machine cut.
- Compact workspace is no longer deferred; it is this manual export and import.
- The artifact layout mirrors the persistence roots (ADR-0257): `kv.json` is the `kv` root, `tables.sqlite` the `tables:` roots, `documents/` the independent row documents.

## Considered alternatives

- **ADR-0167's binary embedded export.** Rejected here: lossless and opaque, it cannot be read or edited by a person, which is the whole motivation, and a reset does not need CRDT identity preserved.
- **Keep Compact workspace deferred (ADR-0256).** Rejected: the motivation is portability and a legible reset, present now, not the speculative storage pressure 0256 waited on.
- **Import that merges into a non-empty workspace.** Rejected: replace-in-place under a fresh identity is the reset; a merge reintroduces the same-identity hazard the supersession gate exists to prevent.
