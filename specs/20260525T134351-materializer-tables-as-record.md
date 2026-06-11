# Materializer `tables` as a record, FTS as a keyed sibling

**Date**: 2026-05-25
**Status**: Draft
**Owner**: Braden / workspace
**Branch**: braden-w/pull-origin-main

## One Sentence

Both materializers take `tables: Tables<TDefs>` (the whole record from `attachTables`) and mirror every entry by default; SQLite gets a sibling `fts: { [tableName]: ColumnKeys[] }` for the rare opt-in, and markdown gets a sibling `perTable: { [tableName]: PerTableConfig }` for filename and serializer overrides.

## Why this exists

The current API requires the caller to enumerate tables via a chained `.table(ref, cfg)` builder:

```ts
attachBunSqliteMaterializer(ydoc, { filePath })
  .table(tables.entries, { fts: ['title', 'body'] });

attachMarkdownMaterializer(ydoc, { dir })
  .table(tables.savedTabs, { filename: slugFilename('title') })
  .table(tables.bookmarks, { filename: slugFilename('title') })
  .table(tables.devices)
  .kv(kv);
```

That enumeration was forced when TypeBox columns did **not** map 1:1 to Drizzle/SQLite types: some columns weren't materializable, so the caller had to pick. After the recent materializer surface cleanup (commit `d411eab64`) and the schema mapping work (commit `760eb8376`), every column a TypeBox table can declare is now materializable. The "pick which tables to mirror" requirement is a constraint paying off a problem that no longer exists.

A side-effect of the chain was per-backend factory rebinding (each of `attachBunSqliteMaterializer`, `attachTursoMaterializer` rebinds `.table()` to thread `.client` / `.whenConnected` through the chain). That code disappears when registration moves out of the chain.

The shape this spec rejects: tuple-array (`tables: [[ref, cfg], ref, [ref, cfg]]`). It was attempted and reverted (commit `0b90d7158` → `f4a79a28e`). The variadic mapped-type inference was brittle, the double-bracket call shape regressed the 80% single-table case, and it kept the "enumerate every table" requirement that this spec removes.

## Current state

```ts
// SQLite
attachBunSqliteMaterializer(ydoc, opts)
  .table(ref, cfg)
  .table(ref, cfg)
  // ^^ .table re-bound in each per-backend factory to thread .client + .whenConnected

// Markdown
attachMarkdownMaterializer(ydoc, opts)
  .table(ref, cfg)
  .table(ref, cfg)
  .kv(kvRef, cfg)
```

Registration window is open between construction and the resolution of `whenFlushed`. Calls to `.table()` / `.kv()` after that throw a runtime error.

Internal flags (`isRegistrationOpen`) and runtime guard messages enforce this.

## Target shape

### SQLite (bun and Turso)

```ts
attachBunSqliteMaterializer(ydoc, {
  filePath: sqlitePath(projectDir, ydoc.guid),
  tables,                              // mirrors everything in the record
});

// With FTS on specific columns of specific tables:
attachBunSqliteMaterializer(ydoc, {
  filePath: ...,
  tables,
  fts: {
    posts: ['title', 'body'],          // key: keyof tables; value: column keys of posts row
  },
});

// Subset (rare): pick the tables you want to mirror
attachBunSqliteMaterializer(ydoc, {
  filePath: ...,
  tables: { notes: tables.notes },
});
```

### Markdown

```ts
attachMarkdownMaterializer(ydoc, {
  dir,
  tables,                              // mirrors everything in the record
  kv,                                  // optional: pass the Kv directly
});

// With per-table customization:
attachMarkdownMaterializer(ydoc, {
  dir,
  tables,
  perTable: {
    posts: { filename: slugFilename('title') },
    files: {
      filename: (row) => row.type === 'folder' ? `${row.id}.md` : toSlugFilename(row.name, row.id),
      toMarkdown: async (row) => { /* ... */ },
    },
  },
  kv,
});

// Subset:
attachMarkdownMaterializer(ydoc, {
  dir,
  tables: { notes: tables.notes },
});
```

`kv` accepts the bare `Kv` reference. KV serializer overrides aren't used anywhere in the repo; defer until needed.

## Type design

### Tables record

```ts
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous row types in a record
type TablesRecord = Record<string, Table<any>>;

// Infer over the tables record directly, not over a TableDefinitions roundtrip
function attach<TTables extends TablesRecord>(
  ydoc: Y.Doc,
  opts: {
    tables: TTables;
    fts?: FtsConfig<TTables>;          // SQLite only
    perTable?: PerTableConfig<TTables>; // Markdown only
    // ... other options
  },
);
```

### FTS narrowing (SQLite)

```ts
type FtsConfig<TTables extends TablesRecord> = {
  [K in keyof TTables]?: TTables[K] extends Table<infer R>
    ? (keyof R & string)[]
    : never;
};
```

Verified inference (probed before writing this spec):

| Call site | Result |
|---|---|
| `fts: { posts: ['title'] }` | ✅ compiles |
| `fts: { typo: [...] }` | ❌ key error |
| `fts: { posts: ['badColumn'] }` | ❌ value error |
| `fts: { posts: ['title', 'badColumn'] }` | ❌ error on the bad one only |
| Subset `tables: { posts: ... }`, then `fts: { notes: ... }` | ❌ key error (notes not in subset) |
| Omit `fts` | ✅ optional |
| Autocomplete on `fts.posts` | ✅ suggests row columns |

### Per-table config narrowing (markdown)

```ts
type MarkdownPerTableConfig<TRow extends BaseRow> = {
  dir?: string;
  filename?: (row: TRow) => MaybePromise<string>;
  toMarkdown?: (row: TRow) => MaybePromise<MarkdownShape>;
  fromMarkdown?: (parsed: MarkdownShape) => MaybePromise<TRow>;
};

type PerTableConfig<TTables extends TablesRecord> = {
  [K in keyof TTables]?: TTables[K] extends Table<infer R>
    ? MarkdownPerTableConfig<R>
    : never;
};
```

Same inference pattern as `fts`. Each per-table block sees the right row type for its callbacks.

## What collapses

### sqlite/core.ts

- Drop `isRegistrationOpen` flag and assignments.
- Drop `MaterializerBuilder` type, `builder` object, `.table()` method.
- Drop `TableConfig.serialize` (the per-column value serializer override: unused in the repo). Keep `serializeValue` as the only value serializer.
- Drop the runtime "called after initial flush" error.
- Take `tables: TTables` and `fts?: FtsConfig<TTables>` in options.
- Populate the `registered` map synchronously before `initialize()`.
- Return a plain object.

### sqlite/bun-sqlite.ts

- Drop the `.table()` re-binding block that threaded `.client`.
- Drop the exported `AttachBunSqliteMaterializerBuilder` augmented type (only used internally; not consumed outside this package per repo grep).
- Return `{ ...core, client }` directly.

### sqlite/turso.ts

- Drop the `.table()` / `.client` / `.whenConnected` re-binding block.
- Drop the exported `AttachTursoMaterializerBuilder` augmented type.
- Return `{ ...core, whenConnected, client: clientPromise }` directly.

### markdown/materializer.ts

- Drop `isRegistrationOpen` flag and the "called after initial flush" errors for both `.table()` and `.kv()`.
- Drop `MaterializerBuilder` type, `builder` object, `.table()` / `.kv()` methods.
- Take `tables: TTables`, `kv?: Kv<any>`, `perTable?: PerTableConfig<TTables>` in options.
- Populate `registered` map + `registeredKv` synchronously.
- Return a plain object.

### JSDoc / comment text to sweep

The `.table()` / `.kv()` methods carry JSDoc that says "Must be called synchronously after construction, before `whenFlushed` resolves. Calls after the initial flush throw." That text dies with the methods. Locations:

- `sqlite/core.ts` `MaterializerBuilder.table` (around line 387): entire method JSDoc disappears.
- `markdown/materializer.ts` `MaterializerBuilder.table` and `.kv` (around lines 609-624): entire method JSDoc disappears.
- Module-level JSDoc on `attachMarkdownMaterializer` says "returns a chainable builder where `.table(tableRef, config?)` opts in..." (around line 214). Rewrite to describe the options-bag shape.

Inline comments inside `initialize()` reference the removed methods:

- `sqlite/core.ts:313-318` ("Always yield a microtask so callers can finish synchronous setup (including writing initial rows) before the full-load runs. Close the registration window: any further `.table()` call throws..."). The yield is still needed for seeding writes; the registration-window comment dies.
- `markdown/materializer.ts:376-381` (same shape, mentions `.table()` / `.kv()` registrations). Same edit.

### Preserve destroy-listener ordering

In both `sqlite/bun-sqlite.ts` and `sqlite/turso.ts`, the per-backend factory currently registers its `client.close()` destroy listener AFTER calling `attachSqliteMaterializerCore`. That order is invariant: core's listener runs first (cancels timers, detaches observers) so the database handle isn't closed under live work. When collapsing the augmented builder to `{ ...core, client }`, keep the order: `const core = attachSqliteMaterializerCore(...)` first, `ydoc.once('destroy', () => client.close())` second, `return { ...core, client }` last.

## Call site updates

```
apps/fuji/daemon.ts:50-56
apps/honeycrisp/daemon.ts:55-64
examples/fuji/epicenter.config.ts:53-65
playground/opensidian-e2e/workspaces/opensidian/daemon.ts:112-151
playground/tab-manager-e2e/workspaces/tabManager/daemon.ts:65-71
```

### Subset migration table

`tables` is a required argument. Passing `tables` (the whole record) mirrors every entry; passing `{ k: tables.k }` (an object literal) mirrors only what you list. Several existing call sites mirror a strict subset today; this migration MUST preserve that intent or it silently creates new SQLite tables and markdown directories the app doesn't want.

| Call site | App's full table set | Currently mirrored (SQLite) | Currently mirrored (Markdown) | Action |
|---|---|---|---|---|
| `apps/fuji` | `{ entries }` | `entries` | `entries` | Pass `tables` (full set = subset) |
| `examples/fuji` | `{ entries }` | `entries` | `entries` | Pass `tables` |
| `apps/honeycrisp` | `{ folders, notes }` | both | `notes` only | SQLite: pass `tables`; Markdown: pass `{ notes: tables.notes }` |
| `opensidian` (playground) | `{ files, conversations, chatMessages, toolTrust }` | `files` only | `files` only | Both: pass `{ files: tables.files }` |
| `tab-manager` (playground) | `{ devices, savedTabs, bookmarks, conversations, chatMessages, toolTrust }` | (no SQLite) | `savedTabs, bookmarks, devices` | Markdown: pass `{ savedTabs: tables.savedTabs, bookmarks: tables.bookmarks, devices: tables.devices }` |

### Opensidian before / after (the strict-subset case)

```ts
// Before
attachMarkdownMaterializer(ydoc, { dir, waitFor: whenReady })
  .table(tables.files, {
    filename: (row) => row.type === 'folder' ? ... : ...,
    toMarkdown: async (row) => { ... },
  });

attachBunSqliteMaterializer(ydoc, { filePath, waitFor: whenReady })
  .table(tables.files, { fts: ['name'] });

// After
attachMarkdownMaterializer(ydoc, {
  dir,
  waitFor: whenReady,
  tables: { files: tables.files },        // subset: only mirror files
  perTable: {
    files: {
      filename: (row) => row.type === 'folder' ? ... : ...,
      toMarkdown: async (row) => { ... },
    },
  },
});

attachBunSqliteMaterializer(ydoc, {
  filePath,
  waitFor: whenReady,
  tables: { files: tables.files },        // subset: only mirror files
  fts: { files: ['name'] },
});
```

### Before / after for the tricky cases

**Honeycrisp** (mirror everything to SQLite; only `notes` to markdown):

```ts
// Before
const sqlite = attachBunSqliteMaterializer(ydoc, { filePath: ..., log: ... });
sqlite.table(tables.folders);
sqlite.table(tables.notes);

attachMarkdownMaterializer(ydoc, { dir: ... })
  .table(tables.notes, { filename: slugFilename('title') });

// After
attachBunSqliteMaterializer(ydoc, {
  filePath: ...,
  log: ...,
  tables,
});

attachMarkdownMaterializer(ydoc, {
  dir: ...,
  tables: { notes: tables.notes },
  perTable: { notes: { filename: slugFilename('title') } },
});
```

**Tab-manager** (markdown mirrors 3 of 6 tables, plus KV):

```ts
// Before
const markdown = attachMarkdownMaterializer(ydoc, { dir, waitFor: whenReady })
  .table(tables.savedTabs, { filename: slugFilename('title') })
  .table(tables.bookmarks, { filename: slugFilename('title') })
  .table(tables.devices)
  .kv(kv);

// After (subset: skip conversations / chatMessages / toolTrust)
const markdown = attachMarkdownMaterializer(ydoc, {
  dir,
  waitFor: whenReady,
  tables: {
    savedTabs: tables.savedTabs,
    bookmarks: tables.bookmarks,
    devices: tables.devices,
  },
  perTable: {
    savedTabs: { filename: slugFilename('title') },
    bookmarks: { filename: slugFilename('title') },
  },
  kv,
});
```

**Opensidian** (one table with heavy callbacks):

```ts
// Before
attachMarkdownMaterializer(ydoc, { dir, waitFor: whenReady })
  .table(tables.files, {
    filename: (row) => row.type === 'folder' ? ... : ...,
    toMarkdown: async (row) => { ... },
  });

// After
attachMarkdownMaterializer(ydoc, {
  dir,
  waitFor: whenReady,
  tables,
  perTable: {
    files: {
      filename: (row) => row.type === 'folder' ? ... : ...,
      toMarkdown: async (row) => { ... },
    },
  },
});
```

## Tests to update

```
packages/workspace/src/document/materializer/sqlite/core.test.ts
packages/workspace/src/document/materializer/sqlite/turso.test.ts
packages/workspace/src/document/materializer/markdown/materializer.test.ts
packages/workspace/src/document/drizzle-schema.test.ts
packages/workspace/src/document/open-sqlite-reader.test.ts
```

Each test currently calls `.table(table, config)` on a materializer. Port to passing `tables` + (optional) `fts` / `perTable` in options.

The "registration after initial flush throws" failure mode is impossible by construction. No such tests exist in the current codebase, but if one is added during the refactor, delete it.

### Helper restructuring in core.test.ts and markdown/materializer.test.ts

Both test files define a `TableRegistration` helper derived from the removed methods:

```ts
type Materializer = ReturnType<typeof attach...Materializer...>;
type TableRegistration = {
  table: Parameters<Materializer['table']>[0];
  config?: Parameters<Materializer['table']>[1];
};
```

That helper dies with the method. The `setup()` function in each file currently takes `tables?: (t: AttachedTables) => TableRegistration[]` and runs `materializer.table(t, c)` in a loop. The replacement: `setup()` takes an options builder, e.g.:

```ts
async function setup(
  build?: (t: AttachedTables) => {
    tables: Record<string, Table<any>>;
    fts?: ...;             // sqlite test
    perTable?: ...;         // markdown test
    kv?: AnyKv;             // markdown test
  },
) { ... }
```

`open-sqlite-reader.test.ts:46-48` has a ternary `fts ? builder.table(..., {fts:...}) : builder.table(...)`. Conditional moves to building the `fts` option:

```ts
const materializer = attachBunSqliteMaterializer(ydoc, {
  filePath,
  debounceMs: 0,
  tables: { entries: tables.entries },
  ...(fts ? { fts: { entries: ['title', 'body'] } } : {}),
});
```

The "ignores notes when only posts is in tables option" test stays semantically meaningful: `tables: { posts: t.posts }` instead of the old subset shape.

## JSDoc / docs updates

- `bun-sqlite.ts:11-21` `@example` block
- `turso.ts:18-30` `@example` block
- `markdown/materializer.ts:228-246` `@example` block
- `markdown/slug-filename.ts:8-13` `@example` block
- `packages/workspace/README.md` lines 963-965 (markdown example) and 1006-1008 (sqlite example)
- `.agents/skills/attach-primitive/SKILL.md` lines 42-64 (materializer chain examples) and lines 130-132 (bundle composition example) and line 188 (reference description)

## Verification

```bash
# 1. Workspace package typechecks alone
cd packages/workspace && bun run typecheck

# 2. All packages typecheck
bun run typecheck

# 3. Workspace tests pass
cd packages/workspace && bun test

# 4. Type-narrowing probe: fts column names error on bad inputs.
#    The probe file is throwaway, written and deleted during execution.

# 5. Greps for stale shapes
rg "\.table\(tables\." packages/ apps/ examples/ playground/
rg "\)\.table\(|materializer\.table\(|sqlite\.table\(|\)\.kv\(" packages/ apps/ examples/ playground/
rg "isRegistrationOpen|MaterializerBuilder|called after initial flush" packages/
rg "AttachBunSqliteMaterializerBuilder|AttachTursoMaterializerBuilder" packages/ apps/ examples/ playground/
# All should return zero hits in source files (specs/ may still reference them historically).
```

## Design decisions

### Why `Tables<TDefs>` (a record), not an array

- Object subset is a natural way to pick "mirror only these": `tables: { posts: tables.posts }`.
- Record keys narrow `fts` / `perTable` keys without variadic gymnastics.
- Default = "mirror everything" matches the 80% case.
- Type inference is standard (`Record<string, Table<any>>` + mapped types), not variadic-tuple-with-`const` (which needed two iterations to get right last time and still felt fragile).

### Why `fts` and `perTable` are sibling slots, not nested under each table

- The 80% case never touches them, so they don't clutter common calls.
- Each sibling slot is sparsely populated (FTS is rare; per-table customization is rare).
- Mapped types over `keyof TTables` narrow cleanly with no `infer R` gymnastics outside the slot itself.
- Conceptually: the table set is one fact ("what to mirror"), FTS is another fact ("which columns are searchable"), per-table is another ("how to render this specific table"). Three slots, three concepts.

### Why not chain `.withFts(...)`

- No inference benefit over the keyed object: TypeScript narrows just as well.
- Would re-introduce the per-backend-factory rebinding problem the chain caused.
- The keyed object is statically inspectable (you can see the FTS config sitting next to the tables in one block); a chain hides it behind another call.

### Why drop `TableConfig.serialize`

- Unused in the repo. The default `serializeValue` handles null/object/boolean correctly for all current callers.
- If a future caller needs a per-column override, add it back inside `perTable` (e.g., `perTable: { posts: { serialize: ... } }`).
- The clean break is the right time to refuse unearned surface.

### Why not refactor FTS into a separate `attachFts(materializer, ...)` primitive

Discussed and deferred. It's a real cleanup but bigger than this spec. The FTS slot here is a sibling option, which is forward-compatible with extracting it later.

## Implementation plan

Six independent units of work. Some can run in parallel because they touch different files; others must be sequential (core types first, then dependents).

1. **Wave 1: core types and SQLite**
   - `sqlite/core.ts`: switch signature, remove builder, return plain object.
   - `sqlite/bun-sqlite.ts`: remove rebind, forward `tables` + `fts`, return `{ ...core, client }`.
   - `sqlite/turso.ts`: remove rebind, forward `tables` + `fts`, return `{ ...core, whenConnected, client }`.
   - Update sqlite tests (`core.test.ts`, `turso.test.ts`, sibling tests in `drizzle-schema.test.ts`, `open-sqlite-reader.test.ts`).

2. **Wave 1 (parallel): markdown**
   - `markdown/materializer.ts`: switch signature, remove builder, return plain object.
   - Update markdown tests (`markdown/materializer.test.ts`).

3. **Wave 2: call sites**
   - `apps/fuji/daemon.ts`
   - `apps/honeycrisp/daemon.ts`
   - `examples/fuji/epicenter.config.ts`
   - `playground/opensidian-e2e/workspaces/opensidian/daemon.ts`
   - `playground/tab-manager-e2e/workspaces/tabManager/daemon.ts`

4. **Wave 3: docs**
   - JSDoc `@example` blocks on each materializer.
   - `slug-filename.ts` JSDoc.
   - `packages/workspace/README.md` examples.
   - `.agents/skills/attach-primitive/SKILL.md` materializer examples.

5. **Verification**: typecheck + test pass.

6. **Commit**: one commit with prefix `refactor(workspace)!:`.

## Open questions

None at draft. Add here if implementation surfaces a real ambiguity.
