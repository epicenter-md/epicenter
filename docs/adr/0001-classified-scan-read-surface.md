# 0001. One classified scan, no valid-only default read

- **Status:** Superseded
- **Date:** 2026-06-15
- **Superseded by:** [ADR-0175](0175-table-traversal-is-complete-and-classified-with-paging-kept-private.md)

> **Bucket list amended by [ADR-0003](0003-three-read-states-after-encryption-removal.md).**
> `scan()` now returns three buckets, not four: the `unreadable` bucket existed
> only for encrypted rows and was removed with the encryption layer. The
> single-classified-scan decision below still stands; read `unreadable` here as
> history.

The workspace table read surface is a single bulk read, `scan()`, that resolves
every stored entry into four buckets (`rows`, `nonconforming`, `newerWriter`,
`unreadable`) and returns them grouped, plus the O(1) point probes `get`, `has`,
`storedCount`, and the short-circuiting `findValid`. We deleted the valid-only
read family (`getAll`, `getAllValid`, `getAllInvalid`, `conformance`, `filter`)
because a default bulk read that returns only conforming rows is a silent-drop
footgun: the common call path hides the other three states. `scan().rows` keeps
the conforming payload one access away while putting the dropped buckets at the
same call site to be logged, surfaced, or deliberately ignored.

## Considered Options

- Keep `getAllValid()` as ergonomic sugar over `scan()`. Rejected: it
  reintroduces the default path that silently drops three states, which is the
  whole reason the redesign exists.
- A single `getAll(): Result[]` primitive plus a pure `classify()` helper.
  Rejected: it pushes the table's own invariants (which version is "newer",
  whether a row is repairable, whether a blob is unreadable) onto every caller
  to re-derive. The table owns `_v` and the key material, so the table owns the
  classification.
- A lazy `*scanEntries()` iterator. Deferred, not rejected: worth adding as a
  lower-level primitive if a streaming caller appears (a 100k-row export that
  must process entries in storage order without materializing all of them).

## Consequences

This was a greenfield clean break: the read surface had no published contract or
external consumer, so every in-repo caller moved to `scan().rows` / `findValid`
/ `storedCount` in the same change. The classification left runtime call sites
and became type facts (`NewerWriter`, `UnreadableRow` as named error variants),
computed once where the knowledge lives and consumed by exhaustive `switch`
elsewhere.
