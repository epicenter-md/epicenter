# 0120. Persisted fields are atomic cells and collaborative bodies are Yjs documents

- **Status:** Proposed
- **Date:** 2026-07-11
- **Relates:** [ADR-0005](0005-child-docs-are-bound-through-the-workspace.md), [ADR-0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md), [ADR-0107](0107-a-child-doc-text-body-is-a-plain-y-text-the-timeline-array-is-deleted.md)

## Context

Epicenter needs one rule that tells schema authors which values use SQLite cell
replacement and which values need collaborative merge semantics. A configurable
merge policy per field would recreate several synchronization engines inside one
schema. The existing `@epicenter/field` package already provides a closed,
recognizable vocabulary with TypeScript inference, runtime validation, editor
hints, and SQLite storage classes; table `.docs(...)` declarations already own
out-of-line Yjs identity and layout.

## Decision

Every persisted table column and KV value is authored with the closed `field.*`
vocabulary, optionally wrapped in `nullable(...)`. `field.json(schema)` is the
only structured-value escape hatch. Raw TypeBox schemas remain valid for action
inputs and other non-storage validation, but not as a second persisted-schema
language.

Every column is one atomic value under server-order replacement. The record wire
language has two semantic operations:

```ts
type Operation =
	| {
			kind: 'patchRow';
			table: string;
			rowId: string;
			cells: Record<string, JsonValue>;
	  }
	| { kind: 'deleteRow'; table: string; rowId: string };
```

`patchRow` creates an unknown row, changes only the named cells of a live row,
and is a no-op for a terminally deleted row. `deleteRow` permanently retires that
row identity, including when deletion reaches the server before creation. The
wire forbids `undefined`; `null` means cleared or absent. The same row id in the
same table and logical database always names the same row. Client-generated
`generateId()` values are retained through sync and logical import. Restoring a
deleted record creates a new id.

KV uses the same record language rather than a third operation family. Each
declared KV key maps to one row in a reserved logical namespace with one `value`
cell. Setting a KV key is `patchRow`; clearing it is `value: null`. The
application's default factory supplies the local read default when the value is
absent.

Content that needs structural or character-level concurrent merging is not a
column. It is declared through `table.docs(...)` and stored as a separate lazy
Yjs document. Normal app schemas choose `Y.Text` for plain collaborative text or
`Y.XmlFragment` for rich text. Raw Yjs layouts and per-field merge-policy options
are not part of the application schema surface.

## Consequences

- `field.string`, `field.boolean`, `field.select`, `field.tags`,
  `field.multiSelect`, and `field.json` all share the same sync behavior: the
  complete cell value is replaced. Their distinct kinds earn validation,
  storage, and editor behavior, not separate conflict algorithms.
- Concurrent assignments to different cells compose. Concurrent assignments to
  the same cell use server acceptance order.
- Arrays in `field.tags`, `field.multiSelect`, and `field.json` do not merge by
  element. Independent contributions belong in independent rows or a Yjs body.
- A generic database editor and import diff can derive widgets from the same
  field schema that generates SQLite storage and validates values.
- Tables and KV share one mutation, snapshot, and conflict model.
  The public APIs remain different because one addresses rows and the other
  addresses declared singleton keys, not because the wire needs more verbs.
- Honest clients only emit values valid for their exact schema epoch. Any change
  to synchronized tables, fields, or field meaning creates a new epoch and
  crosses through logical import; local indexes and internal storage changes do
  not. Structurally valid but nonconforming input from a buggy or dishonest
  client remains storable without creating a second cross-version schema path.
- Existing scalar transcript, note-body, todo-body, and wiki-body columns are
  candidates for a clean move to declared child docs. Existing raw persisted
  TypeBox schemas must move through `field.json` or earn a new closed field kind.

## Considered alternatives

- **Configure `lww`, `set`, `counter`, or `yjs` per field.** Rejected: it creates
  a merge-policy language, several metadata formats, and several snapshot rules.
  A value that is not replaceable scalar metadata needs a different data model.
- **Represent every value in Yjs.** Rejected: raw Yjs map assignments still pick
  one winner, while CRDT history and loading costs remain. Yjs is reserved for
  bodies where its merge semantics carry product value.
- **Permit arbitrary raw TypeBox schemas in persisted tables.** Rejected: a
  second schema language forces fallback storage, validation, editor, migration,
  and sync paths. `field.json` is the explicit atomic escape hatch.
- **Encode terminal deletion as a reserved ordinary cell.** Rejected: deletion
  has identity semantics and earns one explicit operation.
