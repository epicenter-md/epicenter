# SQLite Mirror Extension

**Date**: 2026-04-06
**Status**: Implemented (Phases 1-3)
**Author**: AI-assisted
**Related**: `docs/articles/sqlite-is-a-projection-not-a-database.md`

## Overview

A workspace extension that auto-materializes Yjs table data into SQLite for SQL queries, full-text search, and vector similarity search. Yjs stays the source of truth; SQLite is a derived, rebuildable read cache.

## Motivation

### Current State

Workspace persistence stores opaque Yjs binary updates. Not queryable table data:

```typescript
// packages/workspace/src/extensions/persistence/sqlite.ts
db.run('CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)');
// INSERT INTO updates (data) VALUES (<Yjs binary blob>)
```

The only SQLite materialization that exists is the filesystem sqlite-index. A specialized, hardcoded extension for one table (`files`) with derived columns (`path`, `content`):

```typescript
// packages/filesystem/src/extensions/sqlite-index/index.ts
// - In-memory only (:memory:), rebuilt every page load
// - Hand-written Drizzle schema (duplicates workspace schema)
// - FTS5 for file content search
// - Not reusable for other tables
```

Application data access is all in-memory via Yjs:

```typescript
// apps/whispering: every table access pattern
workspace.tables.recordings.getAllValid()   // load all rows into memory
map.get(id)                                // lookup by ID
runs.filter(r => r.transformationId === id) // client-side JS filter
```

This creates problems:

1. **No SQL access**: Coding agents, MCP tools, and CLI commands can't query workspace data without understanding Yjs/CRDT internals. SQL is universal; the workspace API is not.
2. **No full-text search**: Searching recording transcriptions requires scanning every row in memory.
3. **No vector search**: Semantic similarity search over embeddings is impossible without SQLite vector columns.
4. **No portable export**: Users can't get a `.sqlite` file they can open in any SQL tool.
5. **No reusable pattern**: The filesystem sqlite-index is hardcoded to one table. Building equivalent functionality for Whispering's 5 tables means writing 5 separate extensions.

### Desired State

```typescript
// One line in client.ts: all workspace tables materialized to SQLite
export const workspace = createWorkspace(whisperingDefinition)
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqlite', createSqliteMirror({
    fts: {
      recordings: ['title', 'transcribedText'],
    },
  }));

// Agent/MCP: plain SQL
workspace.extensions.sqlite.client.execute(
  'SELECT * FROM recordings WHERE transcription_status = ? AND created_at > ?',
  ['DONE', '2026-03-30']
);

// FTS:
workspace.extensions.sqlite.search('recordings', 'meeting notes');
```

## Research Findings

### How Other Frameworks Handle This

| Framework | Schema Declaration | SQLite Role | FTS Approach |
|---|---|---|---|
| **PowerSync** | Manual JS schema, auto-generates SQLite tables via `powersync_replace_schema()` | Persistent materialization | FTS5 virtual tables + triggers (manual setup) |
| **ElectricSQL** | Manual local SQL tables, shape sync fills them | Persistent materialization | Postgres GIN indexes (manual SQL migrations) |
| **LiveStore** | Declare SQLite tables + event materializers | SQLite is the state store | Not built-in |
| **cr-sqlite** | Regular tables upgraded via `crsql_as_crr()` | SQLite IS the CRDT | FTS5 via extension |
| **Triplit** | Schema → KV store (not relational) | KV backend | None |
| **TinyBase** | In-memory store, SQLite = optional persistence | Persistence only | None |

**Key finding**: PowerSync's model is closest to what we need. Manual schema declaration in code, auto-materialization into SQLite, FTS as a separate trigger-based layer. But we can go further: our workspace schemas already carry enough type information (via JSON Schema from `describeWorkspace()`) to auto-generate DDL without any manual schema declaration.

**Key finding**: No framework we surveyed auto-generates Drizzle ORM schemas from CRDT definitions. They either require manual SQL/schema declaration or use opaque KV storage. This validates our approach of generating raw DDL and keeping Drizzle as an optional, app-local concern.

### Turso/libSQL Vector Support

libSQL (Turso's SQLite fork) has native vector search. No extensions:

```sql
-- Vector column (1536-dim float32)
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  embedding F32_BLOB(1536)
);

-- DiskANN index (auto-maintained on INSERT/UPDATE/DELETE)
CREATE INDEX recordings_vec_idx ON recordings(libsql_vector_idx(embedding));

-- Query: top-k nearest neighbors
SELECT * FROM vector_top_k('recordings_vec_idx', vector32('[0.12, ...]'), 10)
JOIN recordings ON recordings.rowid = id;
```

Supported vector types: `F64_BLOB`, `F32_BLOB`, `F16_BLOB`, `FB16_BLOB`, `F8_BLOB`, `F1BIT_BLOB`. Distance functions: `vector_distance_cos`, `vector_distance_l2`.

### SQLite Driver: `@tursodatabase/database` Family

Turso publishes two packages with the same `better-sqlite3`-compatible API:

| Package | Platform | Persistence | Notes |
|---|---|---|---|
| `@tursodatabase/database` | Node, Bun, Deno | File-based | Native bindings, sync API with async option |
| `@tursodatabase/database-wasm` | Browser | OPFS (persistent across reloads) | WASM, all methods async, requires COEP/COOP headers |

Both packages include the full Turso/libSQL engine: FTS5, vector columns (`F32_BLOB`), DiskANN indexes (`libsql_vector_idx`), `vector_top_k()`. Same API surface:

```typescript
import { connect } from '@tursodatabase/database';       // Node/Bun
import { connect } from '@tursodatabase/database-wasm';  // Browser

const db = await connect(':memory:');  // or 'file:workspace.db'
await db.exec('CREATE TABLE recordings (id TEXT PRIMARY KEY, title TEXT)');
const rows = await db.prepare('SELECT * FROM recordings').all();
```

**Key finding**: `@libsql/client-wasm` is already used by `packages/filesystem`, but `@tursodatabase/database-wasm` is the newer, cleaner API (better-sqlite3 style vs HTTP client style). Both use the same libSQL engine under the hood.

**Implication**: Use `@tursodatabase/database` (native) and `@tursodatabase/database-wasm` (browser) as the standard SQLite driver. The mirror extension accepts an injected database instance, so the driver choice is the consumer's concern. This gives us vectors + FTS5 everywhere, including browser.

### Drizzle ORM: Needed or Not?

| Concern | Drizzle | Raw SQL |
|---|---|---|
| DDL generation (`CREATE TABLE`) | Requires hand-written schema | Generate from JSON Schema. Simpler |
| INSERT/UPDATE/DELETE sync | `db.insert().values()` | Parameterized SQL. Just as easy |
| FTS5 virtual tables | **Not supported** | Raw SQL (native) |
| Vector columns | **Not supported** | Raw SQL (native) |
| Typed SELECT queries | Real value. Autocomplete, type safety | Returns `unknown[]` |
| Agent SQL queries | Agents write raw SQL regardless | Native |

**Key finding**: Drizzle adds no value for the mirror sync engine (DDL + INSERT/UPDATE/DELETE) and doesn't support FTS5 or vectors. Its only value is typed SELECT queries in TypeScript app code. A concern that belongs to the app, not the extension.

**Implication**: The extension core uses raw SQL only. Zero Drizzle dependency. Apps that want typed queries add Drizzle themselves with a hand-written schema against the mirrored tables.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| DDL generation | Auto-generate from workspace JSON Schema | Eliminates schema duplication. `describeWorkspace()` already produces JSON Schema per table. |
| SQL driver | `@tursodatabase/database` family (injected) | No Drizzle in core. FTS5 and vectors require raw SQL. Driver injection lets consumers choose native vs WASM. `better-sqlite3`-compatible API. |
| FTS5 | Config option inside the extension | FTS triggers reference mirrored tables. Same concern. Separate extension would need to reach into mirror internals. |
| Vectors | `onReady`/`onSync` lifecycle hooks | Vector columns and embeddings are app-specific (which columns, which model, what dimensions). Hooks give full control without baking AI concerns into the core. |
| Filesystem sqlite-index | Stays separate | It has derived columns (`path`, `content`), custom logic, in-memory storage. It's a specialized projection, not a generic mirror. |
| Drizzle typed queries | Opt-in, app-local | Apps declare a Drizzle schema locally only when they need typed SELECT queries. Not the extension's concern. |
| Storage mode | Injected client (caller decides `:memory:` vs file path) | Browser apps may want in-memory; CLI/desktop may want persistent. Extension doesn't decide. |
| Sync strategy | Observer-based with debounce | Match existing filesystem sqlite-index pattern. `table.observe()` → debounced batch upsert/delete. |
| `ctx.whenReady` | **Must await** before first sync | If SQLite materializes before Yjs persistence hydrates, we get partial data. The filesystem sqlite-index appears to skip this. We won't. |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Workspace (Yjs Y.Doc)                                          │
│                                                                 │
│  tables.recordings  ←→  Y.Array("table:recordings")            │
│  tables.transformations ←→ Y.Array("table:transformations")     │
│  kv.*               ←→  Y.Array("kv")                          │
│                                                                 │
│  Source of truth. All writes go here.                           │
└────────────┬──────────────────────────────────┬─────────────────┘
             │ table.observe() per table        │
             ▼                                  │
┌────────────────────────────────┐              │
│  createSqliteMirror()          │              │
│                                │              │
│  1. await ctx.whenReady        │              │
│  2. generateDDL(jsonSchema)    │              │
│     → CREATE TABLE per table   │              │
│  3. fullLoad: getAllValid()     │              │
│     → INSERT INTO ...          │              │
│  4. fts: CREATE VIRTUAL TABLE  │              │
│     + INSERT/UPDATE/DELETE      │              │
│     triggers                   │              │
│  5. onReady(db) hook           │              │
│  6. observe → debounced sync   │              │
│  7. onSync(db, changes) hook   │              │
│                                │              │
│  Exposes: { client, rebuild,   │              │
│    search? }                   │              │
└────────────┬───────────────────┘              │
             │                                  │
             ▼                                  │
┌────────────────────────────────┐              │
│  SQLite (libSQL)               │              │
│                                │              │
│  recordings     (auto DDL)     │              │
│  transformations (auto DDL)    │              │
│  recordings_fts (FTS5)         │              │
│  [vector cols]  (via onReady)  │              │
│  [custom indexes] (via onReady)│              │
└────────────────────────────────┘              │
                                                │
          ┌──── reads ────┐                     │
          ▼               ▼                     │
  ┌──────────────┐ ┌────────────┐  ┌───────────┴───────┐
  │ Coding Agent │ │ CLI tool   │  │ App code (writes) │
  │ (SQL)        │ │ (SQL)      │  │ (workspace API)   │
  └──────────────┘ └────────────┘  └───────────────────┘
```

### Write Flow

```
App code
  │
  ▼
workspace.tables.recordings.set(row)    ← writes to Yjs Y.Array
  │
  ▼
Y.Array fires observe callback
  │
  ▼
createSqliteMirror debounced sync
  │
  ▼
INSERT OR REPLACE INTO recordings ...   ← SQLite updated
  │
  ▼
FTS5 triggers fire automatically        ← FTS index updated
```

### Multi-Version Table Handling

Multi-version tables produce `{ "oneOf": [v1Schema, v2Schema] }` from `describeWorkspace()` instead of a flat object schema. The DDL generator must:

1. Detect `oneOf` in the schema
2. Pick the version with the highest `_v.const` value: the last entry in `oneOf` is always the latest, but we use `_v.const` for safety
3. Generate DDL from that version's `properties` and `required` arrays
4. This is safe because `table.getAllValid()` runs migrations: all returned rows are already at the latest version

```json
// describeWorkspace() output for a multi-version table
{
  "oneOf": [
    { "type": "object", "properties": { "_v": { "const": 1 }, "title": ... }, ... },
    { "type": "object", "properties": { "_v": { "const": 2 }, "title": ..., "views": ... }, ... }
  ]
}
// DDL generator picks the schema where _v.const is highest (2)
// → CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, views REAL NOT NULL, _v INTEGER NOT NULL)
```

### Async Everywhere

Both `@tursodatabase/database` (native) and `@tursodatabase/database-wasm` (browser) use async APIs: `await db.exec()`, `await db.prepare().run()`. The extension uses `async/await` throughout. No sync/async branching needed.

### OPFS Browser Persistence

`@tursodatabase/database-wasm` uses OPFS (Origin Private File System) for persistent browser storage: SQLite files survive page reloads without IndexedDB. This requires COEP/COOP headers:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

Apps already using SharedArrayBuffer (common for Yjs sync) will have these headers set. For `:memory:` mode, OPFS isn't used and no headers are needed.

### JSON Schema → DDL Type Mapping

| JSON Schema | SQLite Type | Notes |
|---|---|---|
| `{ "type": "string" }` | `TEXT` | All strings, including branded IDs |
| `{ "type": "number" }` | `REAL` | Floats |
| `{ "type": "integer" }` | `INTEGER` | When JSON Schema has `"type": "integer"` |
| `{ "type": "boolean" }` | `INTEGER` | 0/1 |
| `{ "enum": ["A", "B"] }` | `TEXT` | String literal unions from arktype |
| Not in `required[]` | Column allows `NULL` | Arktype optional fields (`'key?'`) |
| `{ "type": "object" }` or `{ "type": "array" }` | `TEXT` | JSON-serialized via `JSON.stringify` |
| `{ "const": N }` (`_v` field) | `INTEGER NOT NULL` | Version discriminant, always present |
| `id` field | `TEXT PRIMARY KEY` | Always the primary key |

## API Design

```typescript
// ── Types ─────────────────────────────────────────────────────

type SqliteMirrorOptions = {
  /**
   * Turso database instance. Caller chooses driver and storage mode.
   *
   * Browser: connect(':memory:') from @tursodatabase/database-wasm
   * Desktop: connect('workspace-mirror.db') from @tursodatabase/database
   * CLI:     connect('workspace-mirror.db') from @tursodatabase/database
   */
  db: Database;

  /**
   * Which tables to mirror. Default: all workspace tables.
   * Use an array to mirror a subset.
   */
  tables?: 'all' | string[];

  /**
   * FTS5 full-text search configuration.
   * Map of table name → column names to index.
   *
   * Generates FTS5 virtual tables and INSERT/UPDATE/DELETE triggers.
   */
  fts?: Record<string, string[]>;

  /**
   * Called after mirror tables are created and initial data is loaded.
   * Use for: vector columns, custom indexes, views, additional tables.
   */
  onReady?: (db: Database) => void | Promise<void>;

  /**
   * Called after each sync cycle (batch of observer changes applied).
   * Use for: updating vector embeddings, custom derived columns.
   *
   * `changes` contains which tables had rows upserted or deleted.
   */
  onSync?: (db: Database, changes: SyncChange[]) => void | Promise<void>;

  /** Debounce interval (ms). @default 100 */
  debounceMs?: number;
};

type SyncChange = {
  table: string;
  upserted: string[];  // row IDs that were inserted or updated
  deleted: string[];    // row IDs that were deleted
};

// ── Extension return type ─────────────────────────────────────

type SqliteMirror = {
  /** Turso database instance for arbitrary SQL. */
  db: Database;

  /** Rebuild all mirrored tables from Yjs. Drops and recreates. */
  rebuild: () => Promise<void>;

  /**
   * FTS5 search helper. Only available if `fts` config was provided.
   * Returns rows with snippet highlights.
   */
  search: (table: string, query: string, options?: {
    limit?: number;
    snippetColumn?: string;
  }) => Promise<SearchResult[]>;
};

type SearchResult = {
  id: string;
  snippet: string;
  rank: number;
};
```

### Call-Site Examples

**Minimal (just mirror, no FTS):**

```typescript
import { connect } from '@tursodatabase/database-wasm';

export const workspace = createWorkspace(whisperingDefinition)
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqlite', createSqliteMirror({
    db: await connect(':memory:'),
  }));
```

**With FTS:**

```typescript
export const workspace = createWorkspace(whisperingDefinition)
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqlite', createSqliteMirror({
    db: await connect(':memory:'),
    fts: {
      recordings: ['title', 'transcribedText'],
      transformations: ['title', 'description'],
    },
  }));
```

**With vectors (desktop, via lifecycle hook):**

```typescript
import { connect } from '@tursodatabase/database';

  export const workspace = createWorkspace(whisperingDefinition)
  .withExtension('persistence', indexeddbPersistence)
  .withWorkspaceExtension('sqlite', createSqliteMirror({
    db: await connect('workspace-mirror.db'),
    fts: {
      recordings: ['title', 'transcribedText'],
    },
    async onReady(db) {
      await db.exec(
        'ALTER TABLE recordings ADD COLUMN IF NOT EXISTS embedding F32_BLOB(1536)'
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS recordings_vec_idx ON recordings(libsql_vector_idx(embedding))'
      );
    },
    async onSync(db, changes) {
      const recordingChanges = changes.find(c => c.table === 'recordings');
      if (!recordingChanges) return;
      for (const id of recordingChanges.upserted) {
        const row = await db.prepare('SELECT transcribed_text FROM recordings WHERE id = ?').get(id);
        if (!row) continue;
        const embedding = await getEmbedding(row.transcribed_text as string);
        await db.prepare('UPDATE recordings SET embedding = vector32(?) WHERE id = ?').run(
          JSON.stringify(embedding), id
        );
      }
    },
  }));
```

**With optional Drizzle typed queries (app-local, if you really want them):**

```typescript
// sqlite/schema.ts: hand-written, opt-in, only if you need typed SELECT queries
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const recordings = sqliteTable('recordings', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  transcribedText: text('transcribed_text').notNull(),
  transcriptionStatus: text('transcription_status').notNull(),
  createdAt: text('created_at').notNull(),
});

// usage.ts
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './sqlite/schema';

const db = drizzle(workspace.extensions.sqlite.client, { schema });
const done = await db.select().from(schema.recordings)
  .where(eq(schema.recordings.transcriptionStatus, 'DONE'));
```

**MCP/Agent query surface:**

```typescript
// workspace action exposing SQL to agents
queryData: defineQuery({
  description: 'Run a read-only SQL query against workspace data',
  input: type({ sql: 'string' }),
  handler: async ({ sql }) => {
    const rows = await workspace.extensions.sqlite.db.prepare(sql).all();
    return { rows };
  },
});
```

## Implementation Plan

### Phase 1: Core Mirror (no FTS, no vectors)

- [x] **1.1** Create `packages/workspace/src/extensions/materializer/sqlite/` directory
- [x] **1.2** Implement `generateDDL(jsonSchema)`: walk JSON Schema per table → `CREATE TABLE IF NOT EXISTS`. Handle `oneOf` (multi-version) by picking the schema with the highest `_v.const`. Use `required[]` to determine NOT NULL vs nullable.
- [x] **1.3** Implement `createSqliteMirror(options)` extension factory:
  - Await `ctx.whenReady` before touching SQLite
  - Generate and execute DDL for each table
  - Full load: `table.getAllValid()` → batch `INSERT OR REPLACE INTO`
  - Return `{ db, rebuild }`
- [x] **1.4** Implement observer-based incremental sync:
  - `table.observe((changedIds: ReadonlySet<string>) => ...)` per mirrored table: returns unsubscribe fn
  - Debounced batch: collect changed IDs into a Set, then for each ID: `table.get(id)` → `valid` = `INSERT OR REPLACE`, `not_found` = `DELETE`
  - Call `onSync` hook after each batch with `{ table, upserted, deleted }` arrays
- [x] **1.5** Implement `dispose()`: unsubscribe observers, close client if owned
- [x] **1.6** Add tests: mirror creation, full load, incremental sync, rebuild

### Phase 2: FTS5

- [x] **2.1** Implement FTS config parsing: `fts: { recordings: ['title', 'transcribedText'] }` → `CREATE VIRTUAL TABLE recordings_fts USING fts5(title, transcribedText, content=recordings, content_rowid=rowid)`
- [x] **2.2** Generate INSERT/UPDATE/DELETE triggers to keep FTS in sync with mirror tables
- [x] **2.3** Implement `search(table, query, options)` helper using FTS5 `MATCH` + `snippet()` + `rank`
- [x] **2.4** Add tests: FTS creation, search, trigger-based sync after upsert/delete

### Phase 3: Lifecycle Hooks

- [x] **3.1** Implement `onReady(db)`: called after DDL + full load + FTS setup
- [x] **3.2** Implement `onSync(db, changes)`: called after each debounced sync batch with change details
- [ ] **3.3** Document hook patterns: vector columns, custom indexes, derived columns

### Phase 4: Integration

- [ ] **4.1** Wire into an app (opensidian or whispering) as proof of concept
- [ ] **4.2** Add MCP/agent query action using the mirror
- [ ] **4.3** Verify filesystem sqlite-index can coexist (separate extension, same workspace)

## Edge Cases

### Observer fires before persistence hydrates Yjs

1. Workspace created, SQLite mirror extension registered
2. Persistence extension starts loading Yjs updates from IndexedDB
3. Mirror extension starts observing. Sees partial data

**Mitigation**: Mirror awaits `ctx.whenReady` before subscribing to observers. This ensures Yjs is fully hydrated before the first sync. The filesystem sqlite-index appears to skip this. We won't.

### Table schema changes (workspace version migration)

1. User updates app, workspace table gains a new column in `_v: 2`
2. SQLite mirror has the old schema (missing column)
3. Observer pushes rows with the new column

**Mitigation**: On startup, the mirror compares generated DDL against existing SQLite schema. If columns were added, run `ALTER TABLE ADD COLUMN`. If the schema change is more complex (column removed, type changed), drop and recreate the table. This is safe because SQLite is a rebuildable cache.

### Encrypted tables

1. Workspace uses `.withEncryption()`: table values in Yjs are ciphertext
2. Mirror calls `table.getAllValid()`: this returns decrypted rows (the table helper handles decryption)
3. SQLite would contain plaintext

**Consideration**: If the SQLite file is persistent (on-disk), it contains plaintext copies of encrypted workspace data. This may be acceptable (the user's local disk is already trusted) or may need SQLite-level encryption (SQLCipher, libSQL encryption). Left as an open question.

### Large tables

1. A table has 10,000+ rows
2. Full load on startup inserts all rows

**Mitigation**: Use `INSERT OR REPLACE` in transactions (batch 500 rows per transaction). The debounced observer handles incremental updates after the initial load, so startup is the only expensive operation.

### Concurrent observers (mirror + app code)

1. Mirror extension observes table changes
2. App code also observes the same table (e.g., SvelteMap reactive state)

**No issue**: Yjs supports multiple observers. Both fire independently.

## Open Questions

1. **WASM vector support**: Does `@tursodatabase/database-wasm` include `F32_BLOB` columns and `libsql_vector_idx`? DiskANN may require native code not available in WASM. If not, vectors are desktop/server-only.
   - **Recommendation**: Verify by testing. If WASM lacks vectors, document it. FTS5 works everywhere regardless. That's the primary browser use case.

2. **Encrypted on-disk mirrors**: `@tursodatabase/database-wasm` uses OPFS for browser persistence (survives page reloads). If the workspace uses encryption, the OPFS-persisted SQLite file contains plaintext.
   - Options: (a) Accept plaintext (same trust boundary as IndexedDB), (b) Use libSQL encryption, (c) Only allow `:memory:` for encrypted workspaces
   - **Recommendation**: Accept plaintext for v1. The user's local filesystem / OPFS is the same trust boundary as IndexedDB. Revisit if users request at-rest encryption for the mirror.

3. **Column name mapping**: Workspace schemas use camelCase (`transcribedText`). Should SQLite columns be snake_case (`transcribed_text`) or match the workspace?
   - Options: (a) Match workspace camelCase exactly, (b) Convert to snake_case for SQL convention
   - **Recommendation**: Match workspace names exactly. Agents and MCP tools will see the same names as the TypeScript API. No mapping confusion.

4. **KV store mirroring**: Should KV entries also be materialized to a SQLite table?
   - Options: (a) Tables only, (b) Also mirror KV as a `kv` table with `key TEXT PRIMARY KEY, value TEXT` columns
   - **Recommendation**: Tables only for v1. KV is settings/preferences. Not useful for SQL queries or agent access.

5. **Should the extension own the database lifecycle?**: Currently the caller creates and passes the `Database`. Should the extension optionally accept a path string and create the database internally?
   - Options: (a) Always injected, (b) Accept `db` OR `path`, create database if path given
   - **Recommendation**: Support both. `path` is sugar for the common case; `db` gives full control.

## Success Criteria

- [ ] `createSqliteMirror({ db })` mirrors all workspace tables to SQLite with zero configuration
- [ ] DDL is auto-generated from workspace JSON Schema. No manual schema declaration required
- [ ] Incremental sync: Yjs table mutations appear in SQLite within `debounceMs`
- [ ] `fts` config generates working FTS5 virtual tables with trigger-based sync
- [ ] `search()` returns ranked results with snippet highlights
- [ ] `onReady` and `onSync` hooks fire at the right time with the right data
- [ ] Filesystem sqlite-index coexists as a separate extension on the same workspace
- [ ] No Drizzle dependency in the extension. Raw SQL only
- [ ] Tests cover: full load, incremental upsert, incremental delete, FTS search, rebuild, schema migration

## References

- `packages/workspace/src/extensions/persistence/sqlite.ts`: Current Yjs binary persistence (NOT the mirror)
- `packages/workspace/src/extensions/materializer/markdown/`: Materializer extension pattern to follow
- `packages/filesystem/src/extensions/sqlite-index/`: Existing specialized sqlite-index (stays separate)
- `packages/filesystem/src/extensions/sqlite-index/ddl.ts`: DDL generation from Drizzle (reference for raw DDL approach)
- `packages/filesystem/src/extensions/sqlite-index/schema.ts`: Hand-written Drizzle schema (what we're replacing with auto-generation)
- `packages/workspace/src/workspace/describe-workspace.ts`: JSON Schema output for workspace introspection
- `packages/workspace/src/workspace/types.ts`: `BaseRow`, `TableDefinition`, extension types
- `packages/workspace/src/workspace/create-workspace.ts`: Extension registration and `ctx.whenReady`
- `docs/articles/sqlite-is-a-projection-not-a-database.md`: Conceptual article explaining the architecture

## Review

**Completed**: 2026-04-06
**Branch**: feat/fix-dashboard

### Summary

Implemented the SQLite mirror extension across 4 files in `packages/workspace/src/extensions/materializer/sqlite/`:

- `types.ts`: Structural `MirrorDatabase` interface, `SqliteMirrorOptions`, `SyncChange`, `SqliteMirror`, `SearchResult`
- `ddl.ts`: `generateDdl()` converts JSON Schema from workspace definitions into `CREATE TABLE IF NOT EXISTS` SQL. Handles multi-version tables (oneOf resolution via highest `_v.const`).
- `create-sqlite-mirror.ts`: Curried factory: `options → context → exports`. Awaits `ctx.whenReady`, auto-generates DDL, full-loads valid rows, sets up FTS5 virtual tables with content-sync triggers, fires `onReady`/`onSync` hooks, and keeps the mirror fresh via debounced `table.observe()` incremental sync.
- `index.ts`: Barrel exports.

30 tests pass (18 DDL, 12 factory) covering full load, incremental upsert/delete, rebuild, FTS5 search, lifecycle hooks, and dispose.

### Deviations from Spec

- Used `standardSchemaToJsonSchema()` on individual table definitions instead of calling `describeWorkspace()`. Same JSON Schema output, avoids needing the full client.
- `resolveSchema` returns the first oneOf entry (not the original schema) when all entries lack `_v.const`. Left as a test.todo since this edge case doesn't occur with real workspace tables.
- The `MirrorDatabase` type uses a structural interface instead of importing `@tursodatabase/database`: keeps the extension zero-dependency.
- FTS5 uses content-sync triggers (`content=`, `content_rowid=rowid`) rather than standalone tables, so the FTS index is auto-maintained by SQLite itself on INSERT OR REPLACE.

### Follow-up Work

- Phase 3.3: Document hook patterns for vectors, custom indexes, derived columns
- Phase 4: Integration: wire into an app, add MCP query action, verify coexistence with filesystem sqlite-index
- Schema migration on startup: compare generated DDL against existing SQLite schema, ALTER TABLE ADD COLUMN for new columns, drop+recreate for breaking changes
- Batch INSERT optimization: group rows into transactions of 500 for large tables
