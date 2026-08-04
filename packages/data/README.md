# @epicenter/data

Portable scalar convergence protocol and SQLite-backed local replica for
Epicenter data.

## One Lens declares one namespace

A Lens is one application's interpretation of one durable namespace. The
namespace is declared exactly once, and each `tables` property name is the
durable local name of that table:

```ts
const notesLens = defineLens({
	namespace: 'com.example.notes',
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});

const data = epicenter.bind(notesLens);
```

That makes `notes` address `{ namespace: 'com.example.notes', tableName:
'notes', rowId }` forever. There is no second `key` to keep in step with the
property name, and no rename: a different property name is a different address,
and therefore different data.

A table name is one bare SQL identifier, because a trusted host mounts it as a
relation and `SELECT * FROM notes` must need no quoting.

A row id comes from whoever knows it. Usually nobody does, so `create(fields)`
mints one; when the application knows it, `create(rowId, fields)` uses that.
A settings singleton is an ordinary row at a chosen id, which is why a Lens
declares tables and fields and nothing else (ADR-0206).

## Physical storage is not the merge boundary

Each table row is stored as one JSON payload in SQLite:

```txt
row_facts row
└── fields TEXT
    └── { "title": "Draft", "status": "open" }
```

That does not make the complete row the logical conflict unit. `patch` lowers
the supplied top-level fields into a patch:

```txt
patch(id, { title: "Final" })
              |
              v
{ set: { title: "Final" }, unset: [] }
```

The authority accepts changes in one sequence and applies each patch to its
current row. Patches to different top-level fields compose:

```txt
accepted #41: { title: "Final" }
accepted #42: { status: "closed" }

result: { title: "Final", status: "closed" }
```

Two assignments to the same top-level field do not compose. The later accepted
assignment wins. This is server-ordered, per-field last-accepted-wins, not
timestamp last-write-wins.

## Choose the replacement boundary

The schema already provides four useful choices. Keep the boundary as small as
possible while still preserving the intent of one operation.

```txt
What must merge alone?
|
+-- Independent bounded properties should compose
|   `-- ordinary top-level fields
|
+-- One bounded object should replace coherently
|   `-- one field holding field.json(schema), since a field replaces whole
|
+-- One singleton, however many properties
|   `-- the same table, at a row id the application chooses
|
`-- Independent edits inside one value must survive
    `-- the row-owned Yjs document
```

Use ordinary top-level fields by default:

```ts
const tasks = defineTable({
	fields: {
		title: field.string(),
		status: field.string(),
	},
});
```

This lets title and status patches compose. Table traversal is complete and
classified; applications sort or filter the returned rows locally.

## Read complete tables

Use `scan()` when the classified traversal belongs in memory:

```ts
const { rows, nonconforming } = await tasks.scan();
```

Use `entries()` when work can proceed one classified row at a time:

```ts
for await (const entry of tasks.entries()) {
	if (entry.error !== null) {
		report(entry.error);
		continue;
	}
	await exportTask(entry.data);
}
```

Both traverse live rows in stable row ID order. `entries()` fetches bounded
batches internally, so callers can stop early or keep memory bounded without
constructing cursors. `scan()` consumes that traversal to completion and groups
the same `Result` values. Traversal observes live state, not a snapshot.
Per-row Lens projection failures use those `Result` values. Storage or transport
failures throw from iteration or reject `scan()` instead.

Use one JSON field when the complete bounded object is the honest replacement
unit:

```ts
const exampleLens = defineLens({
	namespace: 'com.example',
	tables: {
		profiles: defineTable({
			fields: { value: field.json(ProfileSchema) },
		}),
	},
});

const profiles = epicenter.bind(exampleLens).profiles;

await profiles.patch(id, { value: nextProfile });
```

The row ID remains structural. The `value` assignment replaces the complete
nested object:

```txt
row
|-- id                  structural identity
`-- value               one replacement boundary
    |-- name
    |-- status
    `-- preferences
```

This pattern is useful for a coherent state machine outcome, a bounded config
object, or another value whose inner properties should never merge
independently. It has one important cost:

A small inner edit sends the complete `value` in the local change. Atomic JSON
is almost free in steady-state storage, but its edit cost is proportional to
the whole payload.

For one named singleton, declare an ordinary table and choose the row's id:

```ts
const settings = defineTable({ fields: { shortcut: field.json(ShortcutSchema) } });

const SETTINGS = 'app'; // the one name this application chooses
await data.settings.patch(SETTINGS, { shortcut });
```

Both devices compute the same address because the id is declared rather than
minted, each field still merges independently, and unsetting one is reversible
because it is a field unset rather than a row deletion.

Use the row-owned Yjs document only when replacement would erase independent
interior edits. Collaborative prose is the usual example. A document earns its
CRDT metadata, hydration, and separate query limitations by preserving edits
that scalar replacement cannot.

Large immutable bytes are a different concern. Keep them in a blob or file
plane rather than turning a scalar JSON value into an opaque byte container.

## Observe staleness

A bound handle reports when data reachable through it may be stale. It never
pushes contents: you re-read through the handle you already have, which keeps
one copy of the data and leaves you in charge of what you cache.

```ts
const stop = tasks.subscribe((invalidation) => {
	if (invalidation.scope === 'table') return void rescan();
	for (const rowId of invalidation.rowIds) void reread(rowId);
});

const stopTheme = settings.subscribe(() => void rereadTheme());
```

A table can name the rows that moved; a value cannot, because a value has no
smaller identity than itself. `{ scope: 'table' }` means the handle cannot name
them, so everything reachable through it may have moved. It arrives after an
observation carrier gap, where a row deleted while the carrier was down left
nothing behind to name.

The rules that make this usable (ADR-0187):

- **Invalidation is a superset.** It may over-report and never under-reports, so
  ignoring the payload and re-reading everything is always correct.
- **Registration is synchronous, does no I/O, and never fires initially.**
  Subscribe, then read: nothing can land in between, and there is no first
  delivery to discard.
- **One call per commit per table.** A commit touching sixty-four rows of one
  table calls a listener once with sixty-four ids.
- **Delivery may duplicate.** Converge idempotently.
- **Table scope supersedes** any row ids still being processed.

`@epicenter/svelte`'s `fromTable` already spends the ids for you: it point-reads
the named rows and rescans only on table scope or when a read cannot answer.

## Unions are not migrations

A discriminated union inside one JSON field keeps the discriminant and its
associated properties in the same replacement boundary:

```ts
const Outcome = Type.Union([
	Type.Object({ kind: Type.Literal('pending') }),
	Type.Object({
		kind: Type.Literal('complete'),
		text: Type.String(),
	}),
]);

const jobs = defineTable({
	fields: { outcome: field.json(Outcome) },
});
```

Use a union when every variant remains a legitimate current product state.
Every reader must handle every variant, and an older release may write an older
variant again.

A historical representation is different. Keep it out of the current row type
and repair it explicitly:

```txt
current definition rejects old raw value
                 |
                 v
one application repair recognizes the old schema
                 |
                 v
an ordinary idempotent update writes the current value
```

Reads remain pure. Repair belongs in one explicit application-owned pass or
registry, not in feature reads and not in the Lens. Keep the recognizer
rerunnable while a supported writer may reintroduce the old shape. Delete it
only after the application has ended that writer compatibility and separately
established that the old shape cannot reappear; live traversal alone does not
prove absence. This keeps repair history bounded without pretending every
repair needs a permanent `.migrate()` chain.

## Self-description and UI

`field.json(schema)` retains its inner JSON Schema. A generic viewer can inspect
the object, render supported properties or discriminated variants, and fall
back to raw JSON without executing application code.

The editing UX must also tell the truth about the write boundary. A form for a
JSON field should commit the complete object on save and explain that its inner
properties replace together. It must not present independently autosaved nested
cells unless the data is modeled as top-level table fields instead.

## Why there is no second table mode

The one-field pattern changes the meaningful merge boundary without adding a
second table definition, parser branch, query family, or Home capability.

A first-class atomic collection API would earn its place only if all of these
become true:

1. At least two concrete tables intentionally store keyed atomic values.
2. The runtime contract changes to honest `create(value)` and
   `replace(id, value)` operations rather than saving `{ value }` syntax.
3. The nested query limitation has an explicit answer.
4. Home needs a distinct semantic capability that cannot be derived from the
   one-field JSON schema.

If that evidence appears, prefer a clearly separate atomic collection noun over
a hidden `writes: 'row'` flag or atomic field groups. Until then, one canonical
table implementation is the smaller and more legible API.

## Storage format

Scalar payloads remain JSON `TEXT`. Wrapping a row in a `value` field does not
compress it. Application-compressed blobs would lose native JSON queries,
constraints, inspection, and schema-aware UI while requiring decompression on
every read.

[SQLite JSONB](https://www.sqlite.org/json1.html#jsonb) is queryable, slightly
smaller, and can avoid parsing for some SQL JSON operations, but it is an
internal binary representation rather than general compression. It does not
change merge semantics or whole-value write amplification, and adapter support
is not yet uniform. Revisit it only after profiling shows JSON parsing or
extraction dominates across the supported engines. If transport bytes become
the measured bottleneck, compress the transport envelope before making
application values opaque.
