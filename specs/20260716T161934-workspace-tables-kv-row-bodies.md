# Workspace Tables, KV, And Fixed Row Bodies

**Date**: 2026-07-16
**Status**: Draft
**Owner**: Braden

## One sentence

A workspace exposes identified rows through tables, every ordinary row owns one
latent collaborative `content` value, and anonymous bounded singleton values
live behind one typed KV lens.

## Decision owners

- [ADR-0130](../docs/adr/0130-workspace-definitions-expose-tables-with-row-owned-bodies-and-a-release-local-kv-lens.md): public tables, bodies, and KV.
- [ADR-0131](../docs/adr/0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md): canonical RowIntent and sealed rounds.
- [ADR-0132](../docs/adr/0132-workspace-kv-is-one-reserved-immortal-record-in-the-record-map.md): reserved KV representation.
- [ADR-0133](../docs/adr/0133-row-bodies-are-sequence-addressed-update-logs-in-the-record-authority.md): authority body outcomes.
- [ADR-0134](../docs/adr/0134-replicas-store-confirmed-state-and-compacted-row-intents.md): replica storage and durability.
- [ADR-0135](../docs/adr/0135-row-bodies-have-one-content-root.md): one fixed body root.
- [ADR-0136](../docs/adr/0136-replica-bootstrap-uses-a-disposable-anchored-live-scan.md): bootstrap without snapshot products.

Internal protocol, storage, and replacement work lives in
[`20260716T204040-confirmed-state-compacted-row-intents.md`](20260716T204040-confirmed-state-compacted-row-intents.md).
This spec owns the public API and consumer path only.

## Placement rule

```txt
table row
  identified, queryable, created and deleted

row body
  collaborative content sharing the row's identity and lifetime

KV entry
  declared anonymous singleton value with no identity, query, or lifecycle

blob
  immutable content-addressed bytes referenced from a row or KV

device state
  local configuration that must not synchronize

derived state
  disposable index, cache, cursor, or projection
```

There is no top-level document collection, parameterized document, independent
body identity, generic CRDT root, or dynamic KV database.

## Target definition

```ts
const notes = defineTable({
	fields: {
		title: field.string(),
		folderId: field.string(),
		pinned: field.boolean(),
	},
	optional: ['folderId', 'pinned'],
});

export const workspace = defineWorkspace({
	id: 'epicenter-honeycrisp',
	tables: { notes },
	kv: {
		'editor.spellcheck': field.boolean(),
		'editor.defaultView': field.select(['reading', 'editing']),
	},
});
```

`defineTable` has no body declaration. Every ordinary row has the same lazy body
at no persisted cost while empty.

## Row surface

```ts
const note = await client.tables.notes.create({
	title: 'Untitled',
});

await client.tables.notes.update(note.id, {
	pinned: true,
	folderId: undefined,
});

const body = await client.tables.notes.body(note.id);

body.binding;

await body.whenDurable();
await client.tables.notes.delete(note.id);
```

The precise method names remain implementation evidence, but the capability
shape is fixed:

```ts
type RowBody = {
	readonly binding: Y.Type;
	whenDurable(): Promise<void>;
};
```

The durable Yjs root key is exactly `content`. An application chooses the editor
binding that interprets it as linear text, a structured ProseMirror tree, or
another supported v14 delta model. One body is one canonical collaborative
value. The workspace has no conversion, materialization, active-kind marker,
fallback reader, second root, or body-kind concept.

The editor models are not interchangeable merely because they accept one Yjs
type. A populated body uses one application interpretation for its lifetime.
Switching interpretations requires an explicit application conversion and
replacement.

The handle exposes the real Yjs shared type as an editor binding. That binding
can carry a `.doc` backpointer. The supported API still provides no direct
document or arbitrary-root accessor; reach-through and unknown roots are
unsupported rather than authority-validated.

Create requires the complete fields required by the current release and may
include an initial body update. Update may change fields, body, or both. Delete
ends the full row lifetime, revokes handles, and cascades through fields and body.
Row ids are minted by the runtime and never reused.

## KV surface

```ts
const spellcheck = await client.kv['editor.spellcheck'].get();
await client.kv['editor.spellcheck'].set(true);
await client.kv['editor.spellcheck'].unset();
```

All declared keys are optional in canonical storage. Reads return a conforming
value, absence, or an honest nonconforming error containing the raw value.
Applications own defaults and repair. Unknown and nonconforming values survive
old releases, bootstrap, import, and export.

Different keys compose independently under authority order. A nested JSON value
replaces atomically. There is no `patchKv`, default materialization, dynamic key
surface, body on KV, or public lifecycle for the reserved internal record.

## Consumer destination

```txt
Honeycrisp notes      row fields + body binding interpreted as structured content
Skills instructions  row fields + body binding interpreted as text
Filesystem files     row fields + body binding interpreted as text
Whispering settings  workspace KV
Vocab settings       workspace KV
Chat messages        ordinary rows, no new body format
```

Honeycrisp binds the same body content to its structured editor. Epicenter does
not encode that application choice as a second public handle.

No consumer receives a private body layout. If a product needs an
application-specific rich-text schema marker, it stores visible schema-opaque
JSON in its row fields and owns the interpretation. Epicenter does not negotiate
editor schemas.

## Public refusals

- No `documents` namespace or `.docs(...)` declaration.
- No optional, selected, multiple, named, or shared row bodies.
- No raw document acquisition or generic root lookup.
- No root name other than `content` in the supported API.
- No `text`, `richText`, `v1:content`, or compatibility roots.
- No automatic text/rich-text conversion, materialization, or dual-source body.
- No caller-supplied or reused deleted row ids.
- No body on workspace KV.
- No dynamic KV or stored defaults.
- No version-history or backup product.

Ownership export/import and operator disaster-recovery backups remain separate
from these refusals.

## Backward path

### Wave 1: Build inert public definitions

- [ ] Remove table body declarations and `.docs(...)` from the target definition.
- [ ] Add direct typed KV schemas with no stored defaults.
- [ ] Reject reserved table names and caller-supplied row ids.

### Wave 2: Expose the fixed runtime surface

- [ ] Add row create/update/delete and the fixed body handle.
- [ ] Expose one editor binding using the exact `content` root key.
- [ ] Add durability acknowledgement and handle revocation.
- [ ] Expose typed KV over the reserved current record.

### Wave 3: Port real consumers

- [ ] Port Honeycrisp to the body binding through its structured editor.
- [ ] Port Skills and Filesystem to the body binding through their text editors.
- [ ] Port Whispering and Vocab settings to typed KV.
- [ ] Keep chat messages as ordinary rows.

### Wave 4: Stop imports and verify

- [ ] Stop production imports of top-level documents, child rooms, `.docs`,
  `defineKv`, body declarations, and compatibility handles.
- [ ] Prove offline create/edit/reopen/delete, both target editor bindings,
  handle races, two-replica merge, bootstrap, unknown KV preservation, and
  export/import.
- [ ] Smoke test each migrated consumer.

### Wave 5: Delete and publish current truth

- [ ] Delete old document catalogs, rooms, routes, persistence, exports, tests,
  body declarations, and compatibility aliases.
- [ ] Accept the implemented ADRs.
- [ ] Update `docs/CONTEXT.md`, reference docs, and workspace/Yjs skills.
- [ ] Delete this spent spec and regenerate spec history.

## Success criteria

- [ ] The public workspace vocabulary is only tables and KV.
- [ ] Every ordinary row exposes one permanent content binding without a
  definition-time choice.
- [ ] No application or authority body-contract registry exists.
- [ ] No second canonical body value or platform conversion path exists.
- [ ] Body deletion follows row deletion in local-only and synchronized modes.
- [ ] Real consumers use the fixed surface and old document paths are unimported
  before deletion.
