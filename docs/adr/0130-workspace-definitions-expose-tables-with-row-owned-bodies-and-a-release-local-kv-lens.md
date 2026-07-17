# 0130. Workspace definitions expose tables with row-owned bodies and a release-local KV lens

- **Status:** Proposed
- **Date:** 2026-07-16
- **Supersedes:** [ADR-0093](0093-kv-metadata-belongs-to-the-workspace-kv-namespace.md), [ADR-0124](0124-workspace-documents-are-top-level-parameterized-resources.md)
- **Relates:** [ADR-0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md), [ADR-0107](0107-a-child-doc-text-body-is-a-plain-y-text-the-timeline-array-is-deleted.md), [ADR-0119](0119-complete-record-maps-sync-through-schema-blind-server-ordered-patches.md), [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0128](0128-tables-do-not-declare-document-edit-touch-policy-without-a-runtime-owner.md), [ADR-0131](0131-record-sync-folds-sealed-replica-rounds-without-refusal.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-record-in-the-record-map.md), [ADR-0133](0133-row-bodies-are-sequence-addressed-update-logs-in-the-record-authority.md)

## Context

The canonical SQLite workspace currently exposes schema-opaque rows through
release-local table lenses, but sends text, rich text, and keyed values through
a separate top-level document vocabulary. Record-related documents therefore
have identities and lifecycles independent from the rows that make them useful,
while small keyed settings pay for Yjs documents, room persistence, and a
second conflict doctrine without merging inside a value.

The older root-Yjs workspace API has the opposite public shape: tables may
declare child documents and the workspace has a top-level `kv` namespace, but
both are backed by Yjs and `defineKv` hides absent or invalid stored values
behind release-local defaults. Neither API states the smallest durable model
the products now require.

## Decision

A workspace definition declares tables of identified rows, a fixed
release-local KV lens over anonymous singleton values, and at most one text or
rich-text body owned by each row.

The target definition shape is:

```ts
const notes = defineTable({
	fields: {
		title: field.string(),
		folderId: field.string(),
		pinned: field.boolean(),
	},
	optional: ['folderId', 'pinned'],
	body: body.richText(),
});

const workspace = defineWorkspace({
	id: 'epicenter-honeycrisp',
	tables: { notes },
	kv: {
		'editor.spellcheck': field.boolean(),
		'editor.defaultView': field.select(['reading', 'editing']),
	},
});
```

Rows retain the record semantics in ADR-0119, ADR-0120, and ADR-0125. A table
may omit `body`, declare `body.text()`, or declare `body.richText()`. A declared
body is lazy, has one fixed format, and inherits its row's identity, authority,
and lifecycle. Applications cannot declare free-standing or parameterized
documents, multiple bodies per row, shared bodies, arbitrary Yjs layouts, or a
generic document escape hatch. A deleted row id is dead forever: creation
mints runtime ids and accepts no caller-supplied id, so recreation is
unreachable rather than fenced, and a late body update for a deleted row is an
accepted deterministic no-op, never an applied write ([ADR-0131](0131-record-sync-folds-sealed-replica-rounds-without-refusal.md),
[ADR-0133](0133-row-bodies-are-sequence-addressed-update-logs-in-the-record-authority.md)).

The `kv` object is itself the definition. Its entries are present-value schemas,
not `defineKv` wrappers. Canonical KV stores bounded JSON independently of any
release. Every declared key is structurally optional in storage. A typed read
returns a conforming value, `undefined` for absence, or a nonconforming error
that includes the raw stored value. A typed set validates the supplied value;
unset removes the key. Reads never materialize defaults, repair invalid values,
delete unknown keys, or migrate stored data. Applications own effective
defaults and explicit repair.

Different KV keys are independent merge units. Concurrent changes to different
keys compose; changes to the same key follow the workspace authority's
deterministic acceptance order. A nested JSON value replaces atomically. The
typed API admits only declared keys, while synchronization, snapshot install,
import, and ownership export preserve unknown and nonconforming bounded JSON.

The public mutation vocabulary is per-key `set` and `unset`, not `patchKv`.
`patchKv` would be ambiguous between an atomic multi-key batch and a deep patch
inside one JSON value. A runtime may later batch several explicit key mutations
in one local transaction without changing their per-key conflict semantics.

This decision fixes the public semantic contract, not its internal encoding. It
does not decide whether KV uses a reserved record address, a dedicated wire
command, a generalized addressed patch, one JSON payload, one physical entry
per key, or another representation. It also does not decide the body merge
engine, transport, row-lifetime token, compaction policy, or snapshot layout.
Those mechanisms must prove this contract and receive follow-on ADRs where they
change accepted wire, storage, or authority decisions.

## Consequences

- `defineWorkspace` has one durable data vocabulary: `tables` and `kv`.
  `documents` disappears.
- `defineTable` owns row structure and may declare one body. Body format is
  table-fixed; body identity is never a public string or parameter record.
- `defineKv(schema, defaultValue)` disappears. Defaults are application
  expressions, and invalid stored bytes remain visible instead of reading as a
  default.
- Every mutable referenceable application object with its own lifecycle is a
  row. KV is reserved for declared workspace-owned singleton values with no
  identity, lifecycle, or query needs. Immutable content-addressed blobs remain
  bytes referenced from rows or KV.
- Text and rich-text bodies retain an earned interior merge engine. The public
  definition does not select that engine. Workspace KV and ordinary record
  collections do not use a CRDT container.
- Device configuration stays in device-local storage. Transient UI state stays
  in memory or the URL. Derived indexes, cursors, caches, and transport metadata
  do not enter user-owned KV.
- Existing top-level and child-document APIs are replacement targets, not
  compatibility surfaces. The implementation builds and proves the new path,
  stops importing the old paths, verifies consumers, and then deletes them.
- ADR-0119's three-command record wire remains accepted until a separate
  internal design proves that it must change. This ADR does not smuggle a
  fourth command into that decision.

## Considered alternatives

- **Keep top-level parameterized documents.** Rejected because every production
  parameter identifies a row by convention, while the independent room
  lifecycle prevents the row from honestly owning deletion and recreation.
- **Keep keyed values in Yjs.** Rejected because bounded replacement values do
  not use interior CRDT merge, but still pay for Yjs metadata, document
  persistence, room lifecycle, and wall-clock conflict resolution.
- **Model KV as an ordinary singleton row.** Rejected at the public model
  because KV has no create, delete, query, or identity lifecycle. An internal
  reserved representation remains an implementation candidate only if it does
  not leak those false semantics.
- **Name the primitive `preferences`.** Rejected because preferences are one
  application use of the more precise platform category: declared singleton
  values with no identity or query needs.
- **Require stored KV keys or persist defaults.** Rejected because doing so
  creates initialization, release ownership, backfill, migration, and reset
  policy for values whose absence already has an honest application fallback.
- **Expose arbitrary dynamic KV.** Rejected because it becomes a second
  database and bypasses the placement rule that identified or queryable data
  belongs in tables.
- **Expose `patchKv({...})`.** Rejected because it hides whether the patch is one
  atomic map replacement, several independent key writes, or a deep merge
  inside nested JSON. Per-key `set` and `unset` keep the merge unit visible.
