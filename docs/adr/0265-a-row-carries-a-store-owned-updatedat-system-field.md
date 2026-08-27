# 0265. A row's `createdAt` and `updatedAt` are store-managed instant fields

- **Status:** Accepted
- **Date:** 2026-08-26
- **Relates:** [ADR-0264](0264-a-table-declares-its-row-documents-derivation-and-file-codec.md) (the pure `derive` these fields are deliberately kept out of), [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md), [ADR-0253](0253-schema-lenses-interpret-stored-json-on-read-and-writes-admit-storage-valid-facts.md), [ADR-0257](0257-the-application-document-has-named-kv-and-table-roots.md)
- **Unbuilt:** the store manages the timestamps, but honeycrisp still stamps `updatedAt` by hand in `updateContent` and its editor chain has not yet been collapsed onto `derive`. Excluding the managed names from `CreateInputOf` (so an application cannot pass them) is a deferred type-only cleanup.

## Context

A list sorts and shows rows by edit time and creation time without opening any document, so those times must live on the row as scalars. They are event facts, when a commit happened, not functions of any content, so they cannot come from the pure `derive` of ADR-0264, and letting `derive` read a wall clock would make it non-deterministic and untestable. Today honeycrisp declares `createdAt`/`updatedAt` and stamps them by hand, the same scattered pattern ADR-0264 deletes for content fields.

## Decision

A table opts into store-managed timestamps by declaring an instant field named `createdAt` or `updatedAt`. The store owns writing them: it stamps `createdAt` once at `create` and `updatedAt` on every commit that touches the row, scalar edits and local document edits alike, from its single injected clock, encoded as an ISO-8601 `InstantString`. An application declares the fields but never writes them; a value it passes is overwritten by the store's stamp.

The convention is by name and by type together. A field is managed only when it is named `createdAt`/`updatedAt` and declared `field.instant()`, so an ordinary field that happens to share a name is left alone. This is opt-in: a table that declares neither gets neither, and no timestamp is forced onto a table that does not want one.

`createdAt` is reinstated (this decision supersedes an earlier draft that dropped it). Once `updatedAt` is stamped on every commit, stamping `createdAt` once at create is nearly free, it is the field honeycrisp actually shows, and "the last-edit time until the first edit" loses the true creation time the moment a row is edited.

## Consequences

- Applications stop hand-stamping timestamps; the store owns them, in one place, for every opting-in table.
- One clock read per commit is shared with the body append, so a document edit and its row's edit time carry the identical instant.
- ISO encoding costs roughly sixteen bytes per row over an epoch number, negligible at personal-data scale, and keeps the timestamp legible in the markdown export (ADR-0267) and consistent with the existing `InstantString` convention.
- The managed names stay in `CreateInputOf` for now, so an application may still pass them and have the value ignored. Excluding them from create input is the honest final shape and is deferred, because it ripples into every application that currently passes a timestamp.
- Managing by name is a convention a reader must know. It is bounded by the instant-typed requirement and by being opt-in, so it never silently captures an unrelated field.

## Considered alternatives

- **Invisible system fields on every row (`id`, `createdAt`, `updatedAt` always present, never declared).** Rejected: it forces timestamps onto tables that do not want them, and changes the shape of every row in every test for little design gain. Opt-in-by-declaration is the better default.
- **Explicit `field.createdAt()` / `field.updatedAt()` constructors.** Rejected: they add API surface and a marker mechanism for a distinction the name-plus-type convention already carries, and "managed timestamp" is a store concern that should not enter the generic MIT field package.
- **`derive` returns `updatedAt`.** Rejected (ADR-0264): a wall clock is not a pure function of the document; the store owning the fields keeps `derive` pure.
- **Epoch-number encoding.** Rejected: the per-row saving is negligible at this scale and trades away legibility in the export that ADR-0267 values.
