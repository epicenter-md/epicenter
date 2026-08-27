# 0265. A row carries a store-owned `updatedAt` system field, and creation time is not one

- **Status:** Accepted
- **Date:** 2026-08-26
- **Relates:** [ADR-0264](0264-a-table-declares-its-row-documents-derivation-and-file-codec.md) (the pure `derive` this field is deliberately kept out of), [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md), [ADR-0253](0253-schema-lenses-interpret-stored-json-on-read-and-writes-admit-storage-valid-facts.md), [ADR-0257](0257-the-application-document-has-named-kv-and-table-roots.md)
- **Unbuilt:** the store does not stamp `updatedAt` yet; honeycrisp stamps it by hand in `updateContent`.

## Context

A list sorts and shows rows by last-edit time without opening any document, so that time must live on the row as a scalar. It is an event fact, when a commit happened, not a function of any content, so it cannot come from the pure `derive` of ADR-0264, and letting `derive` read a wall clock would make it non-deterministic and untestable. Today honeycrisp stamps `updatedAt: InstantString.now()` by hand in its update path, the same scattered pattern ADR-0264 deletes for content fields.

## Decision

`updatedAt` is a store-owned system field present on every row, like `id`. The store stamps it from its single injected commit clock at every local commit that touches the row's scalar fields or its document, using the same timestamp the body append records, so the two never disagree. It is encoded as an ISO-8601 `InstantString`.

Creation time is not a system field. A never-edited row's `updatedAt` already equals its creation time until the first edit; an application that needs an immutable creation time declares its own `createdAt` field and sets it once at `create`.

## Consequences

- Applications stop hand-stamping `updatedAt`; the store owns it, in one place, for every table.
- One clock read per commit is shared between the body append and `updatedAt`, so a document edit and its row's edit time carry the identical instant.
- ISO encoding costs roughly sixteen bytes per row over an epoch number, negligible at personal-data scale, and keeps the timestamp legible in the markdown export (ADR-0267) and consistent with the existing `InstantString` convention.
- There is no `createdAt` system field to maintain, migrate, or store on every row; the applications that want immutable creation time pay for it, and only them.

## Considered alternatives

- **`createdAt` as a system field too.** Rejected: creation is a one-time stamp an application sets trivially at `create`, so it does not earn a universal per-row field the way per-edit `updatedAt`, which needs coverage on every edit path, does. `updatedAt` also carries creation time until the first edit.
- **Epoch-number encoding.** Rejected: the per-row saving is negligible at this scale and trades away legibility in the export that ADR-0267 values, plus the existing `InstantString` convention.
- **`derive` returns `updatedAt`.** Rejected (ADR-0264): a wall clock is not a pure function of the document; the store owning the field keeps `derive` pure.
