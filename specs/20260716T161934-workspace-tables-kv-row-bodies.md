# Workspace Tables, KV, And Row-Owned Bodies

**Date**: 2026-07-16
**Status**: Draft
**Owner**: Braden
**Branch**: `codex/sqlite-sync-architecture`
**Decision**: [ADR-0130](../docs/adr/0130-workspace-definitions-expose-tables-with-row-owned-bodies-and-a-release-local-kv-lens.md)
**Wave 0 outcomes**: the internal owners this spec left open are decided:
[ADR-0131](../docs/adr/0131-record-sync-folds-sealed-replica-rounds-without-refusal.md)
(fold-never-refuse sealed rounds; also restates body lifetime as dead-forever
ids, so the incarnation-token language below is historical),
[ADR-0132](../docs/adr/0132-workspace-kv-is-one-reserved-immortal-record-in-the-record-map.md)
(KV encoding), and
[ADR-0133](../docs/adr/0133-row-bodies-are-sequence-addressed-update-logs-in-the-record-authority.md)
(row/body authority topology). Where a sentence below conflicts with those
ADRs, the ADRs win.

## One Sentence

A workspace definition declares tables of identified rows, a fixed
release-local KV lens over anonymous singleton values, and at most one text or
rich-text body owned by each row.

## Read This First

```txt
Current state:  SQLite tables plus top-level documents, beside an older
                root-Yjs tables/KV/child-doc API.

Target shape:   defineWorkspace({ id, tables, kv }); tables may declare one
                body; there is no documents namespace.

Done means:     the target API is proven in local-only and synchronized
                runtimes, real consumers use it, old imports stop, verification
                passes, and both document systems are deleted.
```

This spec works backward from the agreed target public API. It does not
prescribe a KV command, reserved address, SQLite table, WebSocket envelope,
body update-log shape, or export encoding. Those are evidence questions. An
implementation may choose any internal shape that proves the semantic contract
without creating a second database, sync engine, or lifecycle vocabulary.

The portable folder and external-editing contract remain separate reader jobs
in
[`20260716T112345-portable-workspace-tree-greenfield-dialectic.md`](20260716T112345-portable-workspace-tree-greenfield-dialectic.md).
That spec consumes the owners defined here; it does not choose the workspace
runtime API.

## Why This Change Exists

The repository currently has two document systems:

1. The older root-Yjs workspace lets tables declare child documents and gives
   the workspace a Yjs-backed `kv` namespace.
2. The canonical SQLite workspace gives documents a top-level parameterized
   namespace, including a keyed Yjs document for settings.

Both make ordinary application objects pay for an independent document
identity and lifecycle. The canonical settings document additionally stores 39
small Whispering values in a Y.Doc, persists full document state to IndexedDB,
and synchronizes through a room beside the records authority. None of those
values needs interior text merge.

The target model keeps the distinctions that change behavior:

```txt
table row   identified, queryable object with create and delete lifecycle
KV entry    declared singleton value with no identity, lifecycle, or query
row body    text or rich text whose interior edits genuinely need to merge
blob        binary bytes referenced by rows or KV
```

Everything else is placement policy:

```txt
device configuration  local storage or device SQLite
transient UI state    memory or URL
derived state         disposable index, cache, cursor, or projection
```

## Target Definition API

```ts
import { field } from '@epicenter/field';
import {
	body,
	defineTable,
	defineWorkspace,
	type RowFor,
} from '@epicenter/workspace';
import { Type } from 'typebox';

const KeyBindingSchema = Type.Object({
	modifiers: Type.Array(Type.String()),
	keys: Type.Array(Type.String()),
});

export const foldersTable = defineTable({
	fields: {
		name: field.string(),
		createdAt: field.instant(),
	},
});

export const notesTable = defineTable({
	fields: {
		title: field.string(),
		folderId: field.string(),
		pinned: field.boolean(),
		createdAt: field.instant(),
		attachmentHashes: field.json(Type.Array(Type.String())),
	},
	optional: ['folderId', 'pinned', 'attachmentHashes'],
	body: body.richText(),
});

export type Folder = RowFor<typeof foldersTable>;
export type Note = RowFor<typeof notesTable>;

export const honeycrispWorkspace = defineWorkspace({
	id: 'epicenter-honeycrisp',
	tables: {
		folders: foldersTable,
		notes: notesTable,
	},
	kv: {
		'editor.spellcheck': field.boolean(),
		'editor.defaultView': field.select(['reading', 'editing']),
		'shortcut.newNote': field.json(KeyBindingSchema),
	},
});
```

The definition contains no `documents`, `preferences`, `defineKv`, default
factory, room parameters, public GUID, provider, storage adapter, or sync
control. Runtime-specific composition and actions remain orthogonal to this
durable data contract.

## Table Semantics

`defineTable` remains a release-local lens over schema-opaque JSON rows. The
runtime allocates structural row ids. Fields validate present values; the
table's `optional` list owns which fields may be absent from a conforming row.
Unknown and invalid stored values remain canonical data.

A table may declare one of three body states:

```ts
defineTable({ fields })                         // no body
defineTable({ fields, body: body.text() })      // one Y.Text body per row
defineTable({ fields, body: body.richText() })  // one rich-text body per row
```

There is no body name because a row cannot own two bodies. The body format is
fixed by the table definition. Another collaborative object is another row.

```ts
const note = await client.tables.notes.create({
	title: 'Project plan',
	createdAt: new Date().toISOString(),
});

await client.tables.notes.patch(note.id, { pinned: true });

using opened = await client.tables.notes.body.open(note.id);
const richText = opened.content;
```

The body opens locally while offline. Synchronization may remain parked until
the row create is accepted, but that mechanism is not exposed to the caller.
Deleting a row makes its body unreachable and eventually purges authoritative
body state. Recreating the same row id starts a fresh body lifetime. The
runtime must reject late updates from an earlier lifetime.

The definition does not own edit-to-row projections. Updating `updatedAt`,
preview text, or word count remains explicit application behavior unless a
later product decision gives one runtime owner to that projection.

## KV Is A Lens, Not A Typed Storage Schema

Canonical KV is a bounded map from string keys to JSON values. It has no
application schema. The `kv` property in `defineWorkspace` is this release's
typed lens over that map.

```txt
canonical KV       preserves bounded JSON, including unknown and invalid data
workspace lens     declares known keys and validates present values
application        applies defaults, shows diagnostics, and repairs explicitly
```

KV values may be any bounded JSON value: scalar, null, array, or nested object.
A nested value is atomic for conflict resolution. If independent parts must
merge or be queried, they need separate keys or rows.

Every KV key is structurally optional. A fresh workspace is empty; a release
may add or remove a declaration without writing data; unset returns a key to
absence; and an older release may never have heard of a newer key. Required
canonical keys would force initialization, default ownership, backfill,
migration, and reset policy.

Applications may still make their effective configuration total:

```ts
const reading = await client.kv.get('editor.spellcheck');

if (reading.error) {
	logger.warn(reading.error);
}

const spellcheck = reading.data ?? true;
```

The conceptual typed surface is:

```ts
type KvClient<TDefinitions> = {
	get<K extends keyof TDefinitions>(
		key: K,
	): Promise<Result<Static<TDefinitions[K]> | undefined, NonconformingKvValue>>;

	set<K extends keyof TDefinitions>(
		key: K,
		value: Static<TDefinitions[K]>,
	): Promise<Result<void, InvalidKvWrite>>;

	unset<K extends keyof TDefinitions>(key: K): Promise<void>;

	observe<K extends keyof TDefinitions>(
		key: K,
		handler: () => void,
	): () => void;
};
```

The final implementation should follow the repository's established
`wellcrafted/result` error style. The names above describe the contract; exact
error factory placement remains implementation work.

### Read behavior

```txt
present and valid    Ok(value)
absent               Ok(undefined)
present but invalid  Err({ key, raw, issues })
```

Invalid reads do not return a default. They do not heal, unset, migrate, or
rewrite. The error retains the raw value so the application can diagnose or
repair it deliberately.

### Write behavior

The typed client accepts only keys declared by this release. It validates a set
before durable local admission. An invalid typed set never enters canonical
storage or the outbox. Unset removes the key; it does not store `undefined` or
the application's fallback.

Synchronization, snapshot install, ownership import, and future releases may
introduce keys or values the current lens does not understand. Those raw paths
remain schema-blind. There is no public `setRaw` escape hatch.

### Definition changes never migrate KV

```txt
add a declaration       no write; an existing raw value becomes readable if valid
remove a declaration    no write; the raw key remains preserved
narrow a schema         no write; a previously valid value may read nonconforming
widen a schema          no write; retained raw data may become conforming
rename a key            a new key; no alias, fallback read, or automatic copy
```

Repair is ordinary bounded application code that calls `set` or `unset`.

### Merge semantics

Each top-level key is an independent merge unit. Different-key changes compose.
Same-key changes resolve by deterministic authority acceptance order. Unset
competes with set under the same rule. No device clock participates, and no
losing value remains as conflict history.

This is a semantic promise, not a protocol command specification. The wire may
encode the intent in any form that preserves these results across optimistic
local state, push, pull, snapshot bootstrap, pending replay, and compaction.

### Why there is no `patchKv`

`patchKv({ theme: 'dark', shortcuts: {...} })` does not say which guarantee the
caller receives:

```txt
one atomic replacement of the whole KV map
several independent top-level key writes
a deep merge inside each nested JSON value
```

Those choices have different conflict, retry, and failure behavior. The public
primitive is therefore `set(key, value)` or `unset(key)`: the top-level merge
unit is visible at every call site, and a nested JSON value replaces atomically.

If a consumer proves that several key changes must commit locally together, a
runtime-level transaction or batch may contain several explicit sets and
unsets. That is an atomicity feature, not a new merge doctrine: remote changes
still resolve per key, and the API does not gain a deep object-patch language.

## Real Consumer Translations

### Whispering settings

Current (`apps/whispering/src/lib/workspace/contract.ts:132-138`):

```ts
defineWorkspace({
	id: 'epicenter-whispering',
	tables: { recordings: recordingsTable, recipes: recipesTable },
	documents: {
		settings: document.keyValue({ entries: whisperingSettingEntries }),
	},
});
```

Target:

```ts
defineWorkspace({
	id: 'epicenter-whispering',
	tables: { recordings: recordingsTable, recipes: recipesTable },
	kv: whisperingSettingEntries,
});
```

Whispering's platform-specific defaults remain in application code. The
settings facade switches from a document lease to `client.kv` and must stop
silently defaulting invalid stored values.

### Vocab `showReadings`

Current (`apps/vocab/vocab.ts:135-137`):

```ts
kv: {
	showReadings: defineKv(field.boolean(), () => true),
},
```

Target:

```ts
kv: {
	showReadings: field.boolean(),
},
```

The Vocab UI applies `true` when the stored value is absent. Invalid data is a
diagnostic state rather than an invisible default firing.

### Honeycrisp note body

Current (`apps/honeycrisp/src/lib/workspace/index.ts:96-111`):

```ts
const notesTable = defineTable({
	// fields
}).docs({
	body: {
		layout: attachRichText,
		touch: 'updatedAt',
	},
});
```

Target:

```ts
const notesTable = defineTable({
	fields: {
		// fields
	},
	body: body.richText(),
});
```

The body inherits the note row lifecycle. The automatic `touch` declaration
does not survive; Honeycrisp explicitly owns any derived `updatedAt` patch.

## Settled Contract And Open Mechanisms

| Surface | Settled contract | Mechanism still open |
| --- | --- | --- |
| Workspace definition | `id`, `tables`, `kv`; no `documents` | Internal compilation and serialized definition shape |
| Table body | Zero or one fixed text/rich-text body per row | Merge engine, local update log, hydration, compaction, editor persistence acknowledgement |
| Body lifetime | Follows one row lifetime; recreation starts empty | Incarnation token, authority transaction, stale-update rejection |
| KV lens | Direct schemas, all keys storage-optional, honest read errors | Compiled lens representation and diagnostics aggregation |
| KV mutation | Typed set/unset, per-key composition, nested atomicity | Reserved address, dedicated command, generalized patch, or another encoding |
| KV persistence | Bounded raw JSON survives unknown releases | One JSON payload, one entry per key, or another private SQLite layout |
| Synchronization | One deterministic authority result and durable pending intent | HTTP versus multiplexed socket framing, batching, rejection, backpressure |
| Ownership export | Complete raw rows, KV, bodies, and blobs | Folder names, manifest shape, chunking, body serialization |

## Internal Questions That Must Be Proven

### KV encoding

Compare at least these candidates against the same public contract:

1. A runtime-reserved record address with special absence and lifecycle rules.
2. A first-class KV mutation and state entry inside the existing batch,
   sequence, outbox, snapshot, and compaction machinery.
3. A generalized addressed patch used by rows and the root KV map without
   creating a generic resource owner.

The decision is not the smallest diff. It is the smallest permanent set of
invariants. The winning design must make create/delete lifecycle impossible at
the public boundary, avoid routine quarantine on first writes, preserve
unknown keys, define mixed-version behavior, and reuse delivery machinery
without cloning it.

### KV physical storage

Measure one bounded JSON payload against one physical entry per key. The
payload design rewrites a small object and reuses JSON patch folding. The
entry design matches the logical merge unit but adds snapshot and aggregate
assembly. Choose from browser OPFS and authority measurements, not from the
word "KV".

### Row and body authority

The current records authority and Yjs rooms are independently addressable. That
topology cannot atomically prove that a row is live while accepting or purging
body updates. Prototype the smallest authority boundary that proves:

- a body update concurrent with row deletion cannot survive deletion;
- an offline late update from a deleted row lifetime is permanently rejected;
- row-id recreation starts an empty body and rejects old-lifetime updates;
- snapshot and compaction cannot forget the fact needed for that rejection;
- local editing remains available before the create reaches the authority.

An authority-assigned row incarnation is the leading candidate, not an accepted
mechanism.

### Browser durability

Today's canonical record calls acknowledge after an OPFS SQLite commit. Today's
Yjs document edits persist in the background to IndexedDB and may be lost if
the tab crashes before the write completes. The body prototype must name when
an edit becomes durable and prove close, crash, reopen, and compaction behavior
on real browser storage.

### Body transport

One multiplexed workspace socket may remove per-room connections, but it also
requires body addressing, join authorization, row-lifetime rejection, deletion
notification, reconnect resubscription, and backpressure. Do not choose it only
because one socket sounds smaller. Compare it with separate transports after
the authority owner is settled.

## Refusals

- No free-standing or parameterized documents.
- No multiple or shared bodies.
- No arbitrary Yjs layouts or keyed record collections inside Yjs.
- No Yjs-backed KV.
- No public raw KV write.
- No required canonical KV keys or persisted defaults.
- No dynamic KV keyspace, queries, indexes, namespaces, or instances.
- No automatic data migration when a table or KV lens changes.
- No compatibility alias from `documents`, `.docs`, or old `defineKv` to the
  target API.
- No protocol decision hidden inside the public API ADR.

## Backward Implementation Path

### Wave 0: Prove and record the internal owners

- [ ] Prototype the KV encoding candidates through local write, pending replay,
  authority acceptance, snapshot bootstrap, compaction, and mixed versions.
- [ ] Prototype row/body deletion and recreation races against one concrete
  authority topology.
- [ ] Measure browser edit durability and update-log compaction on OPFS.
- [ ] Write follow-on Proposed ADRs for any change to ADR-0119, ADR-0121,
  ADR-0122, or the current room authority.

### Wave 1: Build the inert definitions and local lenses

- [ ] Add `body.text()` and `body.richText()` definitions.
- [ ] Let `defineTable` accept at most one `body`.
- [ ] Let `defineWorkspace` accept direct KV schemas and omit `kv` as empty.
- [ ] Compile KV present-value validators without defaults or migrations.
- [ ] Add type tests for row bodies and inferred KV get/set values.

### Wave 2: Build the local runtime path

- [ ] Implement honest KV reads, validated writes, unset, and per-key
  observation over schema-opaque local storage.
- [ ] Preserve unknown and nonconforming KV through every known-key write.
- [ ] Persist row bodies through the chosen local update-log design.
- [ ] Prove offline create, edit, close, reopen, trash, hard delete, and row-id
  recreation before enabling remote synchronization.

### Wave 3: Build the synchronized path

- [ ] Implement the accepted KV and body authority mechanisms.
- [ ] Keep local optimistic state, durable pending intent, authority order,
  snapshot install, pending replay, rejection, and compaction coherent.
- [ ] Prove stale body updates cannot cross row lifetimes.
- [ ] Prove same-key KV order and different-key composition with two replicas.

### Wave 4: Port real consumers

- [ ] Port Whispering settings to direct `kv` schemas and explicit defaults.
- [ ] Port Vocab `showReadings` to the canonical KV lens.
- [ ] Port Honeycrisp, Skills, Chat, Filesystem, and remaining document consumers
  to rows with optional bodies or ordinary tables.
- [ ] Record any consumer that fails the placement rule before expanding the
  public API.

### Wave 5: Stop importing the old paths

- [ ] Stop all production imports of top-level `document.*`, table `.docs`,
  `defineKv`, `attachRecords`, and keyed Yjs value stores.
- [ ] Keep the old implementation on disk, unused, as the rollback point.

### Wave 6: Verify the replacement

- [ ] Run package typechecks and targeted workspace, record-sync, server, and
  consumer tests.
- [ ] Run browser crash, two-tab, two-device, authority restart, snapshot,
  compaction, deletion-race, and recreation-race tests.
- [ ] Smoke test Whispering settings, Vocab readings, and Honeycrisp editing in
  their real runtimes.

### Wave 7: Delete the old paths

- [ ] Delete the top-level document definition/runtime and table child-document
  declaration APIs.
- [ ] Delete Yjs-backed KV and old `defineKv` defaults/reset metadata.
- [ ] Delete compatibility tests, fixtures, examples, exports, and docs.
- [ ] Run `rg` for stale public vocabulary and remove every compatibility alias.

### Wave 8: Make the implementation current truth

- [ ] Accept ADR-0130 and any follow-on internal ADRs.
- [ ] Mark ADR-0093 and ADR-0124 superseded and add their successor links.
- [ ] Update `docs/CONTEXT.md`, `docs/reference/workspace-data-model.md`, and
  workspace skills to teach only the implemented API.
- [ ] Delete this spec; git and `docs/spec-history.md` retain the history.

## Proof Matrix

| Invariant | Local | Two replicas | Snapshot/compaction | Crash/restart |
| --- | --- | --- | --- | --- |
| Unknown KV key survives known-key writes | Required | Required | Required | Required |
| Invalid KV value remains raw until explicit repair | Required | Required | Required | Required |
| Absent KV reads `undefined` without materializing a default | Required | Required | Required | Required |
| Different KV keys compose | Required | Required | Required | Required |
| Same KV key follows deterministic authority order | N/A | Required | Required | Required |
| Row body opens lazily and reopens byte-identical | Required | Required | Required | Required |
| Delete rejects concurrent and late body updates | Required | Required | Required | Required |
| Recreated row receives a fresh empty body | Required | Required | Required | Required |
| Old row-lifetime updates cannot enter the new body | Required | Required | Required | Required |

## ADR Disposition

| ADR | Disposition |
| --- | --- |
| ADR-0093 | Superseded when ADR-0130 is accepted. KV definitions no longer own defaults or reset metadata. |
| ADR-0106 | Survives in substance: one body has one fixed layout. Row ownership replaces the child-doc vocabulary. |
| ADR-0107 | Survives in substance: a text body is plain text, not a polymorphic timeline. |
| ADR-0119 | Remains accepted until the KV/body prototype earns a wire change. Do not edit it from this spec. |
| ADR-0120 | Survives. Fields validate present values; tables own row presence; KV presence is always optional. |
| ADR-0121 | Supplies the target same-key authority order. A follow-on ADR is needed only if the mechanism changes its scope. |
| ADR-0122 | Its portability law survives. Snapshot and export shapes need a follow-on decision after internal owners settle. |
| ADR-0124 | Superseded when ADR-0130 is accepted. The `documents` namespace and parameter identity are deleted. |
| ADR-0125 | Survives and generalizes to KV: release-local lenses never migrate canonical data. |
| ADR-0128 | Survives. A body declaration does not gain automatic touch policy. |

## Open Questions

1. **What is the smallest honest KV encoding?**
   - Compare reserved storage, first-class state, and a shared addressed-patch
     core without exposing any of them publicly.
   - Recommendation: choose only after the Wave 0 replay and snapshot prototype.
2. **What authority fact fences row lifetimes?**
   - Authority-assigned incarnation is the leading candidate.
   - Recommendation: reject any design that relies only on row absence or
     tombstone retention, because current compaction permits row-id recreation.
3. **When is a body edit durable in the browser?**
   - Recommendation: an application-visible persistence acknowledgement must
     follow the OPFS transaction that contains the update; measure whether the
     editor needs to await it or only close/crash coordination does.
4. **What are the final KV bounds?**
   - Recommendation: start with 128 declared keys, 8 KiB per value, and 64 KiB
     aggregate, then justify changes with real consumers and admission math.
5. **How does ownership export render KV and bodies?**
   - Deferred to the portable workspace tree dialectic. The invariant here is
     complete raw preservation, not a file name.

## Success Criteria

- [ ] The target API compiles for Honeycrisp, Whispering, and Vocab without a
  `documents`, `.docs`, `defineKv`, or default-factory compatibility surface.
- [ ] KV reads distinguish absence from invalid stored data and never rewrite
  either state.
- [ ] Unknown and nonconforming raw KV survive typed writes, synchronization,
  snapshot bootstrap, export, and import.
- [ ] Row body identity and lifecycle remain private while delete and
  recreation races are proven.
- [ ] No second record collection or keyed-value database remains inside Yjs.
- [ ] Old imports stop before deletion, the full proof matrix passes, and the
  old paths are then removed.
- [ ] Current-state docs change only after implementation; this spec is deleted
  when ADR-0130 becomes Accepted.

## References

- `packages/workspace/src/sqlite/runtime-definition.ts`
- `packages/workspace/src/sqlite/lens-definition.ts`
- `packages/workspace/src/sqlite/canonical-records.ts`
- `packages/workspace/src/sqlite/canonical-replica.ts`
- `packages/workspace/src/sqlite/document-definition.ts`
- `packages/workspace/src/sqlite/document-runtime.ts`
- `packages/workspace/src/document/define-kv.ts`
- `packages/workspace/src/document/kv.ts`
- `packages/record-sync/src/protocol.ts`
- `packages/record-sync/src/authority.ts`
- `packages/server/src/room/core.ts`
- `apps/whispering/src/lib/workspace/contract.ts`
- `apps/vocab/vocab.ts`
- `apps/honeycrisp/src/lib/workspace/index.ts`
