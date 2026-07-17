# 0130. Workspace definitions expose tables with row-owned documents and a release-local KV lens

- **Status:** Proposed
- **Date:** 2026-07-16
- **Supersedes:** [ADR-0093](0093-kv-metadata-belongs-to-the-workspace-kv-namespace.md), [ADR-0124](0124-workspace-documents-are-top-level-parameterized-resources.md)
- **Relates:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0128](0128-tables-do-not-declare-document-edit-touch-policy-without-a-runtime-owner.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-row.md), [ADR-0133](0133-row-authority-stores-documents-as-sequence-addressed-update-logs.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md), [ADR-0135](0135-row-documents-have-application-owned-roots.md), [ADR-0136](0136-replica-baseline-acquisition-uses-a-disposable-anchored-live-scan.md)

## Context

The canonical SQLite workspace exposes schema-opaque rows through release-local
table lenses, but sends text, rich text, and keyed values through a separate
document vocabulary. Row-related documents therefore have identities and
lifecycles independent from the rows that make them useful, while small keyed
settings pay for a second database and conflict doctrine.

## Decision

A workspace definition contains tables and a release-local typed KV lens:

```ts
const notes = defineTable({
	fields: {
		title: field.string(),
		folderId: field.string(),
		pinned: field.boolean(),
	},
	optional: ['folderId', 'pinned'],
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

Every ordinary row inherently owns one lazy collaborative document. The table
does not opt in, declare roots, or choose a format. Its table lens acquires a
disposable native-shaped document handle from ADR-0135:

```ts
using document = await workspace.tables.notes.document.open(row.id);

const editor = document.get('editor');
const comments = document.get('comments');
```

The application owns root names and how each root is interpreted. The public
API exposes no free-standing document identity, raw `Y.Doc`, text/rich-text
mode, root declaration, or conversion operation. Empty documents persist no
bytes.

The row is the public identity and lifecycle aggregate. Its mutation vocabulary
is exactly:

```txt
create   complete fields required by this release, optional initial document update
update   field set/unset changes, a document update, or both
delete   end the row lifetime and cascade through fields and document
```

Creation mints a runtime row id and accepts no caller-supplied id. A deleted id
is never reused. `fields` names the schema-opaque JSON component; `document`
names the collaborative component. `record`, `object`, and `entity` do not
become parallel lifecycle nouns. The document has no identity or lifecycle
independent from its row.

Ordinary row fields are last-accepted-wins values under authority order. Device
time and authorship time do not change that order. A field is therefore the
right model only when a later accepted absolute value may replace an earlier
one. Merge-sensitive collaborative state uses the row document; a workflow
whose correctness depends on validation against current authority state uses
an application-specific authority operation instead of stronger field conflict
machinery.

The `kv` object is itself the definition. Its entries are present-value schemas,
not wrappers with stored defaults. Canonical KV stores bounded JSON independently
of any release. Every key is optional in storage. A typed read returns a
conforming value, `undefined` for absence, or a nonconforming error containing
the raw value. Set validates one supplied value; unset removes one key. Reads
never materialize defaults, repair values, delete unknown keys, or migrate data.

Different KV keys are independent merge units. Concurrent changes to different
keys compose; changes to the same key follow authority order. Nested JSON values
replace atomically. Synchronization, baseline acquisition, import, and ownership
export preserve unknown and nonconforming bounded JSON.

ADRs 0131 through 0136 own RowIntent, the reserved KV representation,
authority document outcomes, replica storage, application-owned roots, and
baseline acquisition. Those private mechanisms must not leak into the public
workspace vocabulary.

## Consequences

- `defineWorkspace` has one durable application vocabulary: `tables` and `kv`.
  Top-level and parameterized documents disappear.
- `defineTable` declares fields only. Every ordinary row has the same latent
  document capability, with no root declaration, contract, or format
  negotiation.
- `defineKv(schema, defaultValue)` disappears. Defaults and repairs remain
  application expressions.
- Every mutable referenceable application value with its own lifecycle is a
  row. KV is for declared workspace-owned singleton values with no identity,
  lifecycle, or query needs.
- JSON fields and KV retain authority-ordered replacement semantics. Only row
  documents pay for interior CRDT merge.
- Existing document APIs and rooms are replacement targets, not compatibility
  surfaces. Build the new path, stop importing the old path, verify, then delete.

## Considered alternatives

- **Keep top-level parameterized documents.** Rejected because production
  parameters identify rows by convention while preventing the row from owning
  deletion.
- **Declare a document layout per table.** Rejected because application-owned
  roots are smaller than permanent per-table layout negotiation.
- **Keep keyed values in Yjs.** Rejected because bounded replacement values do
  not use interior CRDT merge but still pay for document lifecycle.
- **Expose dynamic KV.** Rejected because it becomes a second database and
  bypasses the rule that identified or queryable data belongs in tables.
- **Expose `patchKv`.** Rejected because it hides whether a call is one atomic
  map replacement, several independent key writes, or a nested deep merge.
