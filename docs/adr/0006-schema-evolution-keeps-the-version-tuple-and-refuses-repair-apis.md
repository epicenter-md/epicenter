# 0006. Schema evolution keeps the version tuple and refuses repair APIs

- **Status:** Superseded
- **Date:** 2026-06-12
- **Superseded by:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md)

## Context

A workspace table's schema changes over time, and a stored row may have been
written by an older or newer build than the one reading it. We needed a versioning
scheme that tells a reader which rows it can trust without forcing every caller to
re-derive that judgment, and we had to decide how much machinery to build for
"fixing up" rows that no longer match the current schema.

## Decision

Every row carries a per-row version tuple, `_v`, stamped on write and stripped on
read, and refused as a column key at compile time so the library owns it
end-to-end. Conformance is judged against `_v` and surfaced through the three
`scan()` buckets (see [ADR-0001](0001-classified-scan-read-surface.md) and
[ADR-0003](0003-three-read-states-after-encryption-removal.md)); a stale binary is
stopped from clobbering a newer row by a write guard (`NewerWriterRefusal`). Repair
is implicit: a nonconforming row is rebuilt by reading it and calling `set()`. We
refuse a standalone repair API. There is no `repair()`, `drain()`, or `epochs()`.

## Consequences

- The table owns versioning and conformance; callers read `scan().rows` for the
  conforming set and handle the other two buckets deliberately.
- Migration is on-read: code that wants to upgrade a row reads it and writes it
  back through the normal write path, which re-stamps `_v`.
- No background reconciliation machinery exists to maintain, schedule, or reason
  about. The cost is that bulk upgrades are a caller's `set()` loop, not a
  one-call sweep, which is acceptable given there is no deployed data to migrate at
  scale.

## Considered alternatives

- **A `repair()` / `drain()` / epoch-sweep API.** Refused: it adds a second write
  path and a scheduling surface to do what an ordinary `set()` already does, for a
  problem (mass migration) we do not have.
