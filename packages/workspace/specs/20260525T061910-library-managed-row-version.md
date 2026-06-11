# Library-managed row version

**Date**: 2026-05-25
**Status**: Draft
**Author**: AI-assisted
**Branch**: braden-w/typebox-table-kv-spec

## Overview

The library owns the schema-version discriminator end-to-end. Users declare columns; the library stamps `_v` on every write, strips `_v` from every read, and refuses `_v` as a column key at compile time. The on-disk storage shape is unchanged. The migrate function takes a discriminated `({ value, version })` so `switch (version)` narrows correctly.

## One sentence

> A table is a typed key-value store; if it ever has more than one schema, the library handles version routing and migration. The user writes columns and (when needed) one migrate function. `_v` is never written or read by user code.

## Motivation

### Current state

```ts
const notes = defineTable(
  {
    _v: column.literal(1),                    // ① declared in schema
    id: column.string<NoteId>(),
    title: column.string(),
  },
  {
    _v: column.literal(2),                    // ① declared in schema
    id: column.string<NoteId>(),
    title: column.string(),
    pinned: column.boolean(),
  },
).migrate((row) => {
  switch (row._v) {                           // ② read in migrate
    case 1: return { ...row, pinned: false, _v: 2 as const };   // ③ written in return
    case 2: return row;
  }
});

table.set({
  id: 'note_1' as NoteId,
  title: 'Hi',
  pinned: false,
  _v: 2 as const,                             // ④ written at every set call site
});
```

Problems:

1. **Four sites** the user types `_v` per version. Three in the table definition + every write site forever. Codebase audit shows ~38 tables; the boilerplate falls on all of them.
2. **35 of 38 tables are single-version.** They pay the versioning tax for a feature 92% of them never use.
3. **Uniqueness check is a runtime throw.** `assertUniqueVersionLiterals` fires on module load. Duplicates ship to CI.
4. **`row._v` reads:** searches show only three production reads of `row._v`, all inside migrate switches. No consumer code outside the table layer cares about `_v`. It is library plumbing pretending to be user data.

### Desired state

```ts
// Single-version (the common case): zero versioning concepts in user space.
const folders = defineTable({
  id: column.string<FolderId>(),
  name: column.string(),
  sortOrder: column.number(),
});

folders.set({ id: generateFolderId(), name: 'Inbox', sortOrder: 0 });
folders.get(id); // { id, name, sortOrder }

// Multi-version: versioning surfaces ONLY when there's a v2.
const notes = defineTable(
  // v1
  { id: column.string<NoteId>(), title: column.string() },
  // v2
  { id: column.string<NoteId>(), title: column.string(), pinned: column.boolean() },
).migrate(({ value, version }) => {
  switch (version) {
    case 1: return { ...value, pinned: false };
    case 2: return value;
  }
});

notes.set({ id: 'n_1' as NoteId, title: 'Hi', pinned: false });
notes.get('n_1'); // { id: NoteId, title: string, pinned: boolean }, no _v on the row
```

## Design decisions

| Decision | Choice | Why |
|---|---|---|
| Where does the version live? | In the row's `val` (storage shape unchanged) | Versioning is a table-layer concept; the LWW primitive shouldn't grow a field for it. Rows are self-describing when serialized standalone. |
| `_v` name vs `v` / `_schemaVersion` / `__v` | **Keep `_v`** | Underscore signals "library-internal." Two bytes. Already the name. No churn. |
| Who writes `_v`? | Library, end to end | User never declares, types, or reads `_v`. |
| Refuse `_v` as a column key? | Yes, compile-time error | Defense in depth; users have muscle memory from the old API. |
| Always stamp `_v` (even single-version)? | Yes | Uniform read path (no "is `_v` set?" branch). Future-proof when a single-version table evolves. Cost: 6 bytes per row. |
| Tuple shape vs object-keyed registry? | **Variadic tuple** | TS handles "last element" natively (no recursive type plumbing, no `MAX_VERSION` bound). Position-based prevents reorder/skip anti-features. |
| Migrate signature | `({ value, version }) => latest` | Discriminated union narrows on `switch (version)`. Two-arg form doesn't narrow. |
| Migrate shape | Convergent (one switch over all versions) | All 3 real multi-version tables in the repo have < 10-line migrations. One artifact answers "what versions exist and how do they reach latest." |
| Single-version requires `.migrate()`? | No | Bare `defineTable(cols)` returns a usable `TableDefinition`. Earned trigger: no migration story until there's a real second version. |
| Storage backward-compat fallback? | None needed | The new format IS the current format. Storage shape doesn't change. |
| Encryption wrapper changes? | None | `_v` lives inside `val`, which the wrapper handles opaquely. |
| `ObservableKvStore` / `YKeyValueLwwEntry` changes? | None | Versioning stays at the table layer. |

## Architecture

### Read path

```
STEP 1: ykv.get(key)
  → returns the row val: { id, _v: 2, title, pinned }

STEP 2: peek val._v
  → 2

STEP 3: registry lookup
  → versions[2 - 1] is the v2 column record (tuple position)

STEP 4: Value.Check (val against versionN schema augmented with _v literal)
  → ok

STEP 5: migrate({ value: stripV(val), version: 2 })
  → returns latest row, no _v

STEP 6: return to user
  → { id, title, pinned }
```

### Write path

```
STEP 1: user calls table.set({ id, title, pinned })
  → row has user's columns only

STEP 2: library stamps _v
  → stored = { ...row, _v: LATEST_VERSION }

STEP 3: ykv.set(row.id, stored)
  → YKeyValueLww treats val opaquely
```

### Type-level structure

```
Variadic tuple: T extends readonly VersionedColumns[]
LatestColumns<T> = T extends readonly [...infer _, infer L] ? L : never
LatestRow<T>     = Static<TObject<LatestColumns<T>>>          // user-facing, no _v
StoredRow<T>     = LatestRow<T> & { _v: number }              // library internal

InferTableRow<TDef> = TDef extends TableDefinition<infer T> ? LatestRow<T> : never
```

## Catalog: what the user writes

```ts
// Column records: NO _v allowed (compile error if present).
type VersionedColumns = Record<string, TSchema> & { _v?: never };

// Single-version (most tables):
defineTable(cols: TCols) → TableDefinition<[TCols]>

// Multi-version: requires .migrate before TableDefinition is usable.
defineTable(...versions: TVersions) → MigrationRequired<TVersions>

// .migrate(): convergent, discriminated input, return latest shape.
MigrationRequired<TVersions>.migrate(
  fn: (input: { value: SomeVersionRow; version: number }) => LatestRow
): TableDefinition<TVersions>
```

### What this removes from today's API

- `_v: column.literal(N)` from every column record.
- `_v: N as const` from every migrate return.
- `_v: N as const` from every `table.set(...)` / `bulkSet(...)` call.
- `_v` from `InferTableRow<typeof t>` and downstream consumer types.
- `_v INTEGER NOT NULL` column from SQLite DDL.
- `assertUniqueVersionLiterals` runtime check (positions are structurally unique).
- The `_v.const` walk in `resolveSchema` (SQLite materializer).

## Call sites: before and after

### whispering recordings (multi-version, real)

**Before** (`apps/whispering/src/lib/workspace/definition.ts:25-86`):

```ts
const recordings = defineTable(
  {
    id: column.string<RecordingId>(),
    title: column.string(),
    subtitle: column.string(),
    timestamp: column.string(),
    createdAt: column.string(),
    updatedAt: column.string(),
    transcribedText: column.string(),
    transcriptionStatus: column.enum(['UNPROCESSED', 'TRANSCRIBING', 'DONE', 'FAILED']),
    _v: column.literal(1),
  },
  {
    id: column.string<RecordingId>(),
    title: column.string(),
    recordedAt: column.string(),
    updatedAt: column.string(),
    transcript: column.string(),
    transcriptionStatus: column.enum(['UNPROCESSED', 'TRANSCRIBING', 'DONE', 'FAILED']),
    duration: column.nullable(column.number()),
    _v: column.literal(2),
  },
).migrate((row) => {
  if (row._v === 1) {
    return {
      id: row.id,
      title: row.title,
      recordedAt: row.timestamp,
      updatedAt: row.updatedAt,
      transcript: row.transcribedText,
      transcriptionStatus: row.transcriptionStatus,
      duration: null,
      _v: 2 as const,
    };
  }
  return row;
});
```

**After**:

```ts
const recordings = defineTable(
  // v1
  {
    id: column.string<RecordingId>(),
    title: column.string(),
    subtitle: column.string(),
    timestamp: column.string(),
    createdAt: column.string(),
    updatedAt: column.string(),
    transcribedText: column.string(),
    transcriptionStatus: column.enum(['UNPROCESSED', 'TRANSCRIBING', 'DONE', 'FAILED']),
  },
  // v2
  {
    id: column.string<RecordingId>(),
    title: column.string(),
    recordedAt: column.string(),
    updatedAt: column.string(),
    transcript: column.string(),
    transcriptionStatus: column.enum(['UNPROCESSED', 'TRANSCRIBING', 'DONE', 'FAILED']),
    duration: column.nullable(column.number()),
  },
).migrate(({ value, version }) => {
  switch (version) {
    case 1:
      return {
        id: value.id,
        title: value.title,
        recordedAt: value.timestamp,
        updatedAt: value.updatedAt,
        transcript: value.transcribedText,
        transcriptionStatus: value.transcriptionStatus,
        duration: null,
      };
    case 2:
      return value;
  }
});
```

### honeycrisp foldersTable (single-version, real)

**Before**:

```ts
const foldersTable = defineTable({
  id: column.string<FolderId>(),
  name: column.string(),
  icon: column.nullable(column.string()),
  sortOrder: column.number(),
  _v: column.literal(1),
});
```

**After**:

```ts
const foldersTable = defineTable({
  id: column.string<FolderId>(),
  name: column.string(),
  icon: column.nullable(column.string()),
  sortOrder: column.number(),
});
```

One-line diff per single-version table: strip `_v: column.literal(1),`.

### honeycrisp notesTable (write site)

**Before**:

```ts
notesTable.set({
  id: generateNoteId(),
  title: 'Untitled',
  preview: '',
  pinned: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  wordCount: null,
  _v: 2 as const,
});
```

**After**:

```ts
notesTable.set({
  id: generateNoteId(),
  title: 'Untitled',
  preview: '',
  pinned: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  wordCount: null,
});
```

## Internal TypeScript

The whole point of switching to variadic tuple is that "latest" is one line:

```ts
type LastVersion<TVersions extends readonly VersionedColumns[]> =
  TVersions extends readonly [...infer _, infer L]
    ? L extends VersionedColumns ? L : TVersions[number]
    : TVersions[number];
```

No `MAX_VERSION` ceiling. No recursive types. TypeScript handles variadic tuple destructuring natively.

The migrate input narrows by distributing over the tuple:

```ts
type MigrateInput<TVersions extends readonly VersionedColumns[]> = {
  [K in keyof TVersions]: TVersions[K] extends VersionedColumns
    ? { value: Static<TObject<TVersions[K]>>; version: PositionToVersion<K> }
    : never;
}[number];
```

Where `PositionToVersion<K>` maps tuple index `'0'` → version `1`, `'1'` → version `2`, etc.

The `_v?: never` constraint refuses `_v` as a column key:

```ts
type VersionedColumns = Record<string, TSchema> & { _v?: never };
```

User types `_v: column.literal(1)` in their column record → TypeScript surfaces a readable error.

## Edge cases

### A row stored with unknown `_v`

The library reads `val._v`, looks up `versions[_v - 1]`. If undefined, returns `TableParseError.UnknownVersion`. Same behavior as today.

### Migrate function throws

Wrapped in try/catch in the read path. Returns `TableParseError.MigrationFailed`. Same as today.

### User accidentally types `_v: column.literal(1)` in a column record

Compile error from the `_v?: never` constraint. Readable message: "_v is library-managed; remove it from the column record."

### User calls `set` with `_v` in the row object

TypeScript rejects this because the row type (which is the latest version's columns, no `_v`) does not contain `_v`. No runtime guard needed.

### `update()` on a stored old-version row

Library reads at any version, migrates to latest, applies the partial, writes at latest with `_v` re-stamped. Implicit forward migration on update. This is the only safe semantic and matches today's behavior.

### SQLite materialization

The SQL projection stores latest-version rows only (post-migration). The generated DDL drops the `_v` column entirely. The `resolveSchema` `oneOf` walk in `materializer/sqlite/ddl.ts` is deleted; DDL generates from `definition.schema.row` directly.

## Implementation plan

This is small enough to land in one atomic commit. Library + materializer + tests + consumers, all together. No staged migration because the storage shape doesn't change.

- [ ] **1** Update `define-table.ts`: remove `_v` requirement from `VersionedColumns`; add `_v?: never` constraint; delete `assertUniqueVersionLiterals`; keep variadic shape; keep single-version overload.
- [ ] **2** Update `attach-table.ts`: parse path strips `_v` before validation, library stamps `_v` on `set`/`bulkSet`/`update`. Migrate fn called with `{ value, version }`.
- [ ] **3** Update `column/sugar.ts` JSDoc to reflect that `column.literal` no longer has the `_v` primary use case (it stays as a general literal helper).
- [ ] **4** Update `materializer/sqlite/ddl.ts`: drop `_v INTEGER NOT NULL` generation; delete `resolveSchema` `oneOf` walk; generate from latest `definition.schema.row` directly.
- [ ] **5** Update tests in `packages/workspace`: strip `_v` from column records, migrate returns, write sites. Update migrate signatures to `({ value, version })`.
- [ ] **6** Update benchmarks in `packages/workspace/src/__benchmarks__/` and `packages/workspace/scripts/yjs-benchmarks/`.
- [ ] **7** Update consumer call sites:
  - apps/whispering, honeycrisp, breddit, fuji, zhongwen, opensidian, tab-manager
  - packages/skills, packages/filesystem
  - examples/notes-cross-peer
- [ ] **8** Run `bun typecheck` and `bun test` on `packages/workspace`. Address breakage.

## Open questions

1. **Keep `column.literal` in the namespace?**
   With `_v` removed, `column.literal` loses its primary use case. Recommend keep. It's a one-line re-export of `Type.Literal` with general utility for status enums and other literal-valued fields.

2. **What about consumer-side reads of `row._v` outside migrate functions?**
   Survey shows zero such reads in production code. TypeScript will catch any that exist in code I missed. No proactive defensive measures needed.

3. **Migrate's return type checking.**
   The migrate function should return `LatestRow` (no `_v` in the type). If the user returns `_v: N as const` from copy-pasted old code, it's harmless (library re-stamps over it on write). Could optionally narrow the return type to `Omit<LatestRow, '_v'>` to refuse `_v` in returns, but this adds plumbing for a trivially-tolerable input. Defer.

## Success criteria

- [ ] No source file in the monorepo writes `_v: N as const`.
- [ ] No table schema declares `_v: column.literal(N)`.
- [ ] `InferTableRow<typeof t>` does NOT include `_v` for any table.
- [ ] All workspace package tests pass.
- [ ] `bun typecheck` passes across the monorepo.
- [ ] SQLite-materialized tables do not have a `_v` column.
- [ ] `assertUniqueVersionLiterals` and `resolveSchema._v.const` walk are deleted.
- [ ] The migrate function signature is `({ value, version }) => latest` everywhere.

## References

- `packages/workspace/src/document/define-table.ts`: current API; this spec edits it.
- `packages/workspace/src/document/attach-table.ts`: current parse/migrate machinery; this spec edits the read/write/migrate paths.
- `packages/workspace/src/document/materializer/sqlite/ddl.ts`: drops `_v` column and `oneOf` walk.
- `packages/workspace/src/document/column/sugar.ts`: `column.literal` JSDoc update.
- `.agents/skills/workspace-api/references/table-migrations.md`: needs updating to reflect the new shape.
