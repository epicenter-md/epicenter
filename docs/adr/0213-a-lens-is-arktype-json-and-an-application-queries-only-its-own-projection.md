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
  namespace: 'so.epicenter.honeycrisp',
  tables: {
    notes: { title: 'string', tags: 'string[]', date: 'string|null', body: TEXT },
    // A singleton is a row whose id you chose. Not a second kind of thing.
    settings: { theme: "'light'|'dark'", fontSize: 'number' },
  },
});
```

That object serializes to `{"title":"string","tags":"string[]","date":"string|null"}`
and round-trips byte-identically. A hand-written `lens.json` and a TypeScript
lens are the same artifact. arktype is already a catalog dependency across the
repo.

**There is no `kv` section.** ADR-0206 (`Accepted`, commit `d5e53cca24`,
+1303/-6422 across 130 files) already deleted singleton values after measuring
that exactly one was declared across every shipped lens in the repository. A
draft of this record reintroduced the concept three days later; that is
withdrawn. A singleton is a row at a chosen id, which gets a real SQL relation
and a real `settings/app.md` for free, where a reserved root gets neither and
costs a second read shape, a second write verb and a collision rule. One verb
serves it: `ensure(id, fields)`, get-or-create in one transaction, which replaces
the two-await dance ADR-0206 itself writes and that two shipped apps reimplement.

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

### A content field is not a type, and its sentinel is a string

```ts
export const TEXT = '!text';
```

A **string**, never a `unique symbol`. `JSON.stringify({ body: Symbol() })` is
`{}`: a symbol-valued key vanishes, so a symbol sentinel would silently break
this record's central claim that a lens round-trips byte-identically, for every
lens that declares prose. `!` cannot begin an arktype expression, so the value is
unambiguous.

It marks a field as a separate document under ADR-0212 and is excluded from
arktype entirely, because the stored value is a Yjs document and there is nothing
to validate. Naming it for the Yjs type rather than for a policy leaves room for
one additive value, `'!xml'`, when an application with a live producer needs a
tree Epicenter cannot render to markdown.

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

**You never hold a row. You hold a table.**

```ts
const { data: store } = await openBunEpicenter({ path });   // one adapter per runtime
const { data: notes } = store.bind(lens);                   // sync, Result-returning

const { data: note } = await notes.notes.create({ title: 'Groceries', tags: ['food'] });
note.title                                   // a property on a FROZEN plain object
await notes.notes.set(note.id, { title: 'Shopping' });
await notes.notes.ensure('app', { theme: 'light', fontSize: 14 });   // the singleton verb
const { data: prose } = await notes.notes.prose(note.id, 'body');
prose.text().insert(0, 'buy milk');
await notes.notes.delete(note.id);

const rows = await notes.query`
  SELECT id, title FROM notes
  WHERE EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ${'food'})`;
```

**A read returns a frozen plain object with no methods.** That matters because on
a live handle `note.title === undefined` means three things at once: the field is
null, the row was tombstoned by a peer, or the value fails the current lens
(ADR-0125). A property getter is the one syntax in JavaScript that can report
none of them. On a snapshot returned by an awaited verb, the validation already
happened, so the property cannot lie. It also survives a template, a `sort`
comparator, `structuredClone` and `postMessage`, which a `Result` per field does
not.

**Every verb is on the table and takes the id.** Presence and the write then
happen in one Yjs transaction, which a handle cannot guarantee: `Doc.get` mints,
so a write through a stale handle would leave a row with fields and no
`!presence`. A row has no methods, so no field name is reserved except `id`, and
field names come from users. Jazz shipped methods on the row, hit exactly this,
and moved everything under `$jazz` in 0.18.0.

**`prose()` is asynchronous** because opening a document is a load, and a round
trip to another process on two of three shipped surfaces. `set` accepts scalars
only: content fields are absent from the patch type by construction, so a
document can never be replaced behind an editor's back.

**`bind` is synchronous and returns a `Result`.** Synchronous because it does no
I/O. Result-returning because a lens may arrive as data from an installed app
folder, and `compileTableDefinition` throws for exactly that case today
(`definitions.ts:331-333`).

**There is no `epicenter.open({ path })`.** Three adapters already exist and
their I/O has nothing in common: Bun's open is one `mkdir`, the browser's is a
Web Lock plus a WASM compile plus an OPFS pool, and desktop's is two round trips
that never open a file. A path is also a second name for a thing ADR-0204 says
has exactly one, and ADR-0201 forbids handing one across an application
boundary.

`query` lives on the binding, not the store, so an application reaches only its
own namespace. Results are bounded and Result-returning; bare rows cannot say
"this was clipped".

### Names

| instead of | use | because |
| --- | --- | --- |
| `columns` | `fields` | 13% of the real vault's notes carry `subtitle`. That is a normal field and a bad column. The projection has columns; the store has fields |
| `field.string()` | `'string'` | a builder returns this same JSON, and adds a compile step plus an identity-keyed cache, which is where both existing bugs came from |
| `optional: [...]` | `'string|null'` | a marker in the key does not survive a JSON round trip; a union in the value does |
| `epicenter.open({ path })` | one adapter per runtime, each returning a `Result` | ADR-0204 says a thing has exactly one name, and the three opens share no I/O profile |
| `const app = ...` | name it for the lens | `app` already means an installed application with an authority id and a partition |
| `note.title = 'x'`, then `note.set({...})` | `notes.set(id, {...})` | assignment cannot fail or be awaited; and a handle carrying only an id does not prove the row still exists, so presence and the write must share one transaction |
| `note.body.insert(0, 'x')` | `await notes.prose(id, 'body')` then `.text().insert(...)` | it is a load, and a round trip on two of three shipped surfaces. A synchronous chain in front of it gives back the whole startup win |
| `body: content` (a `unique symbol`) | `body: TEXT` (`'!text'`) | `JSON.stringify` drops a symbol-valued key, so a lens declaring prose did not round-trip |
| `kv: { ... }` | a table with a chosen row id, plus `ensure()` | ADR-0206 already deleted the concept after measuring one declared value repo-wide |
| `bind(lens): Bound` | `Result<Bound, LensError>` | a lens loaded from disk is uncompilable today (`definitions.ts:331-333`) |

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
- **`values` has no slot and no verbs.** ADR-0206 deleted the concept, the
  relations, the wire operations and the dotted grammar. A draft of this record
  claimed the slot survived in the canonical JSON; it does not, and
  `packages/lens/src/definitions.ts:85-99` has neither a values nor a kv slot.
- **Epicenter Home keeps cross-application SQL** and it stays a host capability
  reached through the storage owner, not a connection handed to anyone.
