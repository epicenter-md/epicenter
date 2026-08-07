# 0213. A lens is arktype JSON, and an application queries only its own projection

- **Status:** Proposed
- **Date:** 2026-08-07
- **Provisional number.** Replaces an earlier 0213 that specified a multiset
  digest for a cell store that no longer exists. That draft was `Proposed` and is
  rewritten in place.
- **Relates:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
  (the store), [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (where the projection lives).
- **Amends:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md)
  at one clause. Withdrawn: that application-facing APIs "expose no `sql()`
  method". An application may run read-only SQL over **its own** projection. What
  survives is everything else: no raw connection, no cross-namespace reach, and
  Epicenter Home keeps relational inspection across applications as a trusted
  host capability. The reason the clause can go is ADR-0214's one-file-per-app
  layout: an application's file is the boundary, so the refusal no longer buys
  isolation that the filesystem does not already give.
- **Confirms:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md) and
  [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md). Neither is
  amended. An earlier reading held that ADR-0125 forbade validation; it does not,
  and the misreading is corrected below.

## Context

A lens has three jobs and only three: give an application types, tell the
projection what columns to build, and tell the folder which field is the body. It
has never had the job of gating what may be stored, because ADR-0125 requires a
release to preserve values it cannot read.

The earlier lens implementation carried two bugs that both come from treating the
schema as something to *build* rather than something to *be*:

- `compiledTables` is a `WeakMap` keyed on object identity
  (`packages/lens/src/definitions.ts:187-188`), and compilation throws
  `'Unknown table definition'` for anything it did not itself mint (`:331-333`).
  A lens loaded from disk is therefore uncompilable, which contradicts
  ADR-0168:86 outright.
- `optional` never survives serialization: `cloneSchema` runs a JSON round trip
  at `:226` and the optionality marker is read off the pre-clone schema into a
  side `Set` at `:233`. A serialized lens reports every optional field as
  required.

Both disappear if the lens *is* the JSON rather than being compiled into it.

## Decision

### A lens is arktype syntax, and arktype syntax is JSON

```ts
export const lens = defineLens({
  tables: {
    notes: { title: 'string', tags: 'string[]', date: 'string|null', body: content },
  },
  kv: { theme: "'light'|'dark'", fontSize: 'number' },
});
```

That object serializes to `{"title":"string","tags":"string[]","date":"string|null"}`
and round-trips byte-identically. A hand-written `lens.json` and a TypeScript
lens are the same artifact. arktype is already a catalog dependency across the
repo.

`defineLens` is inference and validation, not construction:

```ts
export function defineLens<const L>(lens: L & ValidateLens<L>): L { return lens as L }
```

The intersection is load-bearing: `L` infers from the literal, and
`ValidateLens<L>` applies `type.validate` per field. Verified by typechecking a
mock. Correct usage compiles with zero errors and infers `title: string`,
`tags: string[]`, `date: string | null`, `theme: 'light' | 'dark'`. Four
deliberate mistakes are all caught: a non-keyword (`'strng'`), reading a field at
the wrong type, treating a content field as a string, and a malformed union.
Autocomplete inside the quotes comes from arktype's own `type.validate`, which is
exported; nothing about its type-level machinery is reimplemented.

### Fields are nullable, never optional

`'string|null'`, not `'date?'`. Every field is always present, so the projection
is one column per field with no exceptions and no marker to lose. The frontmatter
renderer omits nulls, which is a rendering rule rather than a schema fact.

This collapses "cleared" and "never set" into one state. That distinction is
deliberately given up.

### A content field is not a type

`content` is a sentinel, not an arktype string, because the stored value is a
Yjs document and there is nothing to validate. It marks a field as a separate
document under ADR-0212 and is excluded from the arktype object entirely.

### Validation happens three times and never gates storage

The reading that ADR-0125 forbids validation is wrong. ADR-0125:33, verbatim:
*"A release validates values it understands and preserves everything else. Typed
patches modify only explicit keys, validate only supplied values, and may modify
a row whose complete payload does not pass the current lens."* Per-supplied-value
validation is mandated. What is forbidden is whole-row admission gating,
aliases, `fallbackFrom`, automatic rename, schema versions, migration chains, and
default backfill. ADR-0168:84-86 blesses compiling validators at bind time.

| | checks | on failure |
| --- | --- | --- |
| **legitimacy** | the lens JSON is well formed and every field is recognized vocabulary | `Err(LensParseError)`; the lens is a visible broken artifact |
| **write** | each **supplied** value against its field | `Err(NonconformingWrite)`; refuse the call, touch no other field |
| **read** | the **stored** payload against the current lens | `Err(NonconformingRow)` carrying the raw payload unmodified; report, never repair |

Validator compilation is memoised on the content hash of the canonical JSON, not
on object identity.

### The application surface

```ts
const { data: store, error } = await epicenter.open({ path });
const notes = store.bind(lens);            // synchronous, repeatable

const { data: note } = notes.notes.create({ title: 'Groceries', tags: ['food'] });
note.set({ title: 'Shopping' });           // Result<void, WriteError>
note.body.insert(0, 'buy milk');           // the content document
notes.notes.delete(note.id);

const rows = await notes.query`
  SELECT id, title FROM notes
  WHERE EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ${'food'})`;
```

Opening a file and binding a lens are separate: a lens is an interpretation of a
namespace, not a lifecycle scope, and several lenses may bind to one store.

**Reads are properties. Writes are verbs, and every one returns a `Result`.**
Assignment has exactly one failure channel, which is to throw, and a `Result`
cannot be retrofitted onto `=` later. `note.title = 'x'` could not report a write
to a tombstoned row, a nonconforming value, or a disposed store; `row.set(...)`
can.

`row.set` accepts scalars only. A content field's Yjs document is never replaced,
because a handle an editor still holds keeps accepting writes that go nowhere
(ADR-0212). The types enforce it: content fields infer as a document handle, so
they are absent from the patch type by construction.

`query` lives on the binding, not the store, so an application reaches only its
own namespace. Results are bounded and Result-returning; bare rows cannot say
"this was clipped".

### Names

| instead of | use | because |
| --- | --- | --- |
| `columns` | `fields` | 13% of the real vault's notes carry `subtitle`. That is a normal field and a bad column. The projection has columns; the store has fields |
| `field.string()` | `'string'` | a builder returns this same JSON, and adds a compile step plus an identity-keyed cache, which is where both existing bugs came from |
| `optional: [...]` | `'string|null'` | a marker in the key does not survive a JSON round trip; a union in the value does |
| `epicenter.open(lens)` | `open({path})` then `bind(lens)` | a lens is not a file boundary |
| `const app = ...` | name it for the lens | `app` already means an installed application with an authority id and a partition |
| `note.title = 'x'` | `note.set({ title: 'x' })` | assignment cannot fail, cannot be awaited, and cannot express unsetting |

`query` is reserved as a table name, because a table becomes a key on the same
handle that carries the method.

## Consequences

- **A lens on disk and a lens in TypeScript are the same bytes**, so an
  application can ship one, an agent can read one, and neither needs a compiler.
- **Introspection is free.** arktype exposes `.props`, `.expression` and `.json`,
  which is enough to render a form or a table header with no extra metadata:
  measured, `date optional=false string | null`, `tags optional=false string[]`.
  Error messages are already legible: *"tags must be an array (was string)"*.
- **A nonconforming row is returned, never repaired and never hidden.** The
  property getter for the offending field yields `undefined`, `read()` returns
  the error, and the raw payload including uninterpretable keys stays intact.
- **`values` keeps its slot in the canonical lens JSON and ships no verbs.**
  Nothing in `packages/` implements them; a surface with no live producer is
  refused.
- **Epicenter Home keeps cross-application SQL** and it stays a host capability
  reached through the storage owner, not a connection handed to anyone.
