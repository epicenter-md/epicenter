# Workspace Tables, KV, And Row Documents

**Date**: 2026-07-16
**Status**: Draft
**Owner**: Braden

## One sentence

A workspace exposes identified rows through tables, every ordinary row owns one
lazy application-composed collaborative document, and anonymous bounded
singleton values live behind one typed KV lens.

## Decision owners

- [ADR-0130](../docs/adr/0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md): public tables, documents, and KV.
- [ADR-0131](../docs/adr/0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md): canonical RowIntent and sealed rounds.
- [ADR-0132](../docs/adr/0132-workspace-kv-is-one-reserved-immortal-row.md): reserved KV representation.
- [ADR-0133](../docs/adr/0133-row-authority-stores-documents-as-sequence-addressed-update-logs.md): authority document outcomes.
- [ADR-0134](../docs/adr/0134-replicas-store-confirmed-state-and-compacted-row-intents.md): replica storage and durability.
- [ADR-0135](../docs/adr/0135-row-documents-have-application-owned-roots.md): the native-shaped document surface and application-owned roots.
- [ADR-0136](../docs/adr/0136-replica-baseline-acquisition-uses-a-disposable-anchored-live-scan.md): baseline acquisition without snapshot products.

Internal protocol, storage, and replacement work lives in
[`20260716T204040-confirmed-state-compacted-row-intents.md`](20260716T204040-confirmed-state-compacted-row-intents.md).
This spec owns the public API and consumer path only.

## Placement rule

```txt
table row
  identified, queryable, created and deleted

row document
  application-composed collaborative state sharing the row's identity and lifetime

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
document identity, raw Y.Doc acquisition, or dynamic KV database.

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

`defineTable` has no document or root declaration. Every ordinary row has the
same lazy document capability at no persisted cost while empty.

## Row surface

```ts
const note = await client.tables.notes.create({
	title: 'Untitled',
});

await client.tables.notes.update(note.id, {
	pinned: true,
	folderId: undefined,
});

using document = await client.tables.notes.document.open(note.id);

const editor = document.get('editor');
const comments = document.get('comments');

document.transact(() => {
	editor.insert(0, 'Hello');
}, 'editor');

// Normal editing does not await this. This is an explicit durable boundary.
await document.whenDurable();
```

The acquisition name and capability shape are fixed:

```ts
type RowDocument = {
	get: Y.Doc['get'];
	/**
	 * Groups application-authored changes into one local Yjs transaction.
	 *
	 * This signature deliberately restates rather than derives
	 * `Y.Doc['transact']`: Yjs's third `local` parameter belongs to provider
	 * infrastructure, so application code must not control it.
	 *
	 * @example
	 * document.transact(() => {
	 * 	editor.insert(0, 'Hello');
	 * }, 'editor');
	 */
	transact<TValue>(
		callback: (transaction: Y.Transaction) => TValue,
		origin?: unknown,
	): TValue;
	/**
	 * Waits until the SQLite transaction containing every local update observed
	 * before this call has committed.
	 *
	 * Persistence starts automatically. Normal editing does not await this;
	 * use it only when another operation requires a durable local boundary.
	 */
	whenDurable(): Promise<void>;
	[Symbol.dispose](): void;
};
```

`get` derives Yjs's exact native signature. `transact` preserves the native
callback and origin shape while withholding its provider-facing `local` flag.
Its eventual public implementation must retain this JSDoc because the missing
parameter is an intentional authority boundary. Persistence begins
automatically; `whenDurable` is only an optional barrier for a caller that must
know every local document update observed before the call is included in a
committed transaction in the canonical workspace database. The browser OPFS
runtime uses `journal_mode = DELETE` with `synchronous = FULL`, so there is no
WAL checkpoint on that path. The method does not wait for authority acceptance.
Normal editor updates do not await it. `[Symbol.dispose]` releases the cached
lease; the workspace finishes already queued persistence independently and owns
eventual Yjs document destruction. Disposal neither waits for durability nor
cancels an observed update. Retained roots are unsupported after lease disposal
or row deletion.

The SQLite workspace file is the durability boundary. This row-document path
does not attach `y-indexeddb` and does not retain browser IndexedDB as another
persistence owner. Existing IndexedDB-backed paths are migration sources only.

`open(rowId)` resolves only after row liveness checking, cached-lease
acquisition, hydration from confirmed plus pending SQLite state, and update
capture installation. It does not wait for remote convergence. The asynchronous
boundary prevents callers from receiving a half-hydrated document.

Root names and interpretations are durable application schema. One application
may bind `editor` as structured content and use `comments` for another
collaborative feature. Editor models are not interchangeable merely because
they accept the same Yjs type. Changing a populated root's name or
interpretation requires an explicit application conversion and replacement.

The handle returns real Yjs `Type` roots, whose `.doc` backpointer makes raw
reach-through possible but unsupported. The handle itself does not expose the
raw `Y.Doc`, provider events, update application, identity, loading, or
destruction. Epicenter owns document lifecycle and synchronization.
Applications own the layout inside that boundary.

Create requires the complete fields required by the current release and may
include an initial document update. Update may change fields, document, or
both. Delete ends the full row lifetime, revokes handles, and cascades through
fields and document. Row ids are minted by the runtime and never reused.

Ordinary scalar fields use absolute set/unset and later authority acceptance
wins. Device clocks and authorship timestamps do not arbitrate conflicts. The
document uses Yjs merge. A critical workflow whose correctness depends on
current authority state belongs in an application-specific authority operation,
not in stronger generic field semantics.

## KV surface

```ts
const spellcheck = await client.kv['editor.spellcheck'].get();
await client.kv['editor.spellcheck'].set(true);
await client.kv['editor.spellcheck'].unset();
```

All declared keys are optional in canonical storage. Reads return a conforming
value, absence, or an honest nonconforming error containing the raw value.
Applications own defaults and repair. Unknown and nonconforming values survive
old releases, baseline acquisition, import, and export.

Different keys compose independently under authority order. A nested JSON value
replaces atomically. There is no `patchKv`, default materialization, dynamic key
surface, document on KV, or public lifecycle for the reserved internal row.

## Consumer destination

```txt
Honeycrisp notes      row fields + application-owned structured roots
Skills instructions  row fields + application-owned text roots
Filesystem files     row fields + application-owned text roots
Whispering settings  workspace KV
Vocab settings       workspace KV
Chat messages        ordinary rows, no new document format
```

Honeycrisp chooses and binds its own structured root. Epicenter does not encode
that application choice into the table definition or a second public handle.

No consumer receives a private document layout. If a product needs an
application-specific rich-text schema marker, it stores visible schema-opaque
JSON in its row fields and owns the interpretation. Epicenter does not negotiate
editor schemas.

## Public refusals

- No `documents` namespace or `.docs(...)` declaration.
- No optional, selected, or independently identified row documents.
- No raw `Y.Doc` acquisition or provider control.
- No platform-reserved, declared, negotiated, or version-prefixed roots.
- No automatic text/rich-text conversion, materialization, or dual-source
  document.
- No caller-supplied or reused deleted row ids.
- No document on workspace KV.
- No dynamic KV or stored defaults.
- No version-history or backup product.

Ownership export/import and operator disaster-recovery backups remain separate
from these refusals.

## Backward path

### Wave 1: Build inert public definitions

- [ ] Remove table document declarations and `.docs(...)` from the target
  definition.
- [ ] Add direct typed KV schemas with no stored defaults.
- [ ] Reject reserved table names and caller-supplied row ids.

### Wave 2: Expose the native-shaped runtime surface

- [ ] Add row create/update/delete and `table.document.open(rowId)`.
- [ ] Expose `get`, application-local `transact`, `whenDurable`, and lease disposal.
- [ ] Add durability acknowledgement and handle revocation.
- [ ] Expose typed KV over the reserved current row.

### Wave 3: Port real consumers

- [ ] Port Honeycrisp to its application-owned structured root.
- [ ] Port Skills and Filesystem to their application-owned text roots.
- [ ] Port Whispering and Vocab settings to typed KV.
- [ ] Keep chat messages as ordinary rows.

### Wave 4: Stop imports and verify

- [ ] Stop production imports of top-level documents, child rooms, `.docs`,
  `defineKv`, document declarations, and compatibility handles.
- [ ] Prove offline create/edit/reopen/delete, multiple roots, both target editor
  bindings, handle races, two-replica merge, baseline acquisition, unknown KV
  preservation, and export/import.
- [ ] Smoke test each migrated consumer.

### Wave 5: Delete and publish current truth

- [ ] Delete old document catalogs, rooms, routes, persistence, exports, tests,
  document declarations, and compatibility aliases.
- [ ] Accept the implemented ADRs.
- [ ] Update `docs/CONTEXT.md`, reference docs, and workspace/Yjs skills.
- [ ] Delete this spent spec and regenerate spec history.

## Success criteria

- [ ] The public workspace vocabulary is only tables and KV.
- [ ] Every ordinary row exposes one lazy document with application-owned roots
  and no definition-time choice.
- [ ] No application or authority document-contract registry exists.
- [ ] No root registry, platform interpretation, or conversion path exists.
- [ ] Document deletion follows row deletion in local-only and synchronized
  modes.
- [ ] Real consumers use the native-shaped surface and old document paths are
  unimported before deletion.
