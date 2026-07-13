# 0129. Matter is Markdown-authoritative; application records follow developer-owned schemas

- **Status:** Proposed
- **Date:** 2026-07-13
- **Relates:** [ADR-0065](0065-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md), [ADR-0119](0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md), [ADR-0122](0122-logical-snapshots-are-the-portable-record-database-format-sqlite-files-are-runtime-state.md)

## Context

Matter vaults and application databases both benefit from portable field
descriptions, local queries, and agent access. Treating that shared vocabulary
as one authority model would require bidirectional Markdown and SQLite sync,
schema inference, rename and deletion inference, and conflict rules between two
writable representations of the same value.

## Decision

A Matter source is user-shaped and Markdown-authoritative. Its optional
folder-level `matter.json` describes a lens over files; its SQLite projection is
disposable and read-only. The files remain valid without the lens.

An application source is developer-shaped. Its TypeScript definition owns the
schema and generates a mandatory portable descriptor. Logical records are the
durable data, and every device may materialize a complete local SQLite database
for offline queries and edits through the application mutation boundary.

Both source kinds use the closed `field.*` vocabulary, including advisory
same-source references. They do not share an authority, synchronization engine,
or writable materialization. Epicenter does not bidirectionally synchronize a
Matter folder and an application database or persist references across sources.

## Consequences

- Matter users may let structure emerge through ordinary files and Git before
  recording repeated structure in `matter.json`.
- Application developers may rely on stable fields while users retain a
  portable description and complete queryable copy of their records.
- A field reference communicates that one value is intended to name a row. It
  does not create a foreign key, cascade, inverse relation, or generic repair
  engine.
- Matter edits files. Application writes use typed mutations and may enter a
  synchronization outbox. There is no generic force-push between the two.
- A future combined view may query distinct sources, but it cannot erase their
  authority boundaries or create cross-source transactions.

## Considered alternatives

- **Make SQLite the authority for every workspace.** Rejected: exploratory
  writing and user-shaped structure would become application migrations.
- **Make Markdown the portable writable form of every application.** Rejected:
  reverse serialization would turn filenames, frontmatter, nullability, and
  missing files into a second application protocol.
- **Keep both sides writable.** Rejected: two authorities require permanent
  reconciliation machinery and make neither medium honest.
