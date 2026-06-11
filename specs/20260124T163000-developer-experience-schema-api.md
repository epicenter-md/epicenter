# Developer Experience: Schema Definition and Migration API

> **⚠️ PARTIALLY SUPERSEDED**
>
> The migration approach in this spec has been superseded by [`specs/20260124T162638-stable-id-schema-pattern.md`](./20260124T162638-stable-id-schema-pattern.md).
>
> **What's still valuable here**:
> - Challenge 1: Multi-Peer Writes analysis
> - Cell-level vs Row-level LWW discussion
> - The problem framing for schema evolution
>
> **What's obsolete**:
> - The versioning and migration strategies (Challenges 2-3)
> - Per-row `_v` tracking
> - Migration race condition handling
>
> **The new approach**: Stable internal IDs that never change. Renaming = change schema key, keep same ID. Invalid data returns default. No migrations.

---

**Status**: Draft - Iterating (Partially Superseded)
**Date**: 2026-01-24
**Context**: Designing the developer-facing API for defining schemas, tables, and KV stores with YJS synchronization
**Builds On**: `specs/20260124T125300-workspace-schema-versioning.md`, `specs/20260124T004528-versioned-table-api-design.md`

---

## Executive Summary

This spec focuses on **developer experience (DX)** for Epicenter's data layer. The goal: make it feel like working with a modern ORM, not a CRDT framework.

**Key Principles:**
1. Use existing schema libraries (ArkType, Standard Schema): no proprietary field syntax
2. Strong opinions on migrations: one obvious way to do things
3. Cell-level editing by default: YJS handles conflicts naturally
4. Minimize footguns: make the safe thing the easy thing

---

## The Core Problem

You want to build local-first apps with sync. Conceptually simple:

```
User has data → Data syncs across devices → Everyone sees the same thing
```

But local-first sync introduces hard problems that traditional databases don't have.

---

## Challenge 1: Multi-Peer Writes Without a Server

**Traditional database:**
```
Client → Server → Database
         ↑
         Server decides order, rejects conflicts
```

**Local-first:**
```
Device A ←→ Device B ←→ Device C
     ↑           ↑           ↑
     All can write offline, all sync later
```

**The problem**: No central authority. When Device A and Device B both edit offline, who wins?

**YJS's answer**: Last-Write-Wins (LWW) at the Y.Map key level. Deterministic ordering based on internal operation IDs.

**Our question**: At what granularity? Entire rows? Individual fields?

---

## Challenge 2: Schema Evolution Over Time

Apps evolve. You ship v1 with:
```typescript
{ id: string, title: string }
```

Later you need:
```typescript
{ id: string, title: string, status: 'pending' | 'done', priority: number }
```

**Traditional database**: Run a migration script once, coordinated.

**Local-first**:
- Device A might have app v2 (new schema)
- Device B might still run app v1 (old schema)
- They sync the same data
- Old data and new data coexist

**The questions**:
- Where do we store "what version is this workspace"?
- When do we migrate data?
- Who triggers migration?
- What if two devices both try to migrate simultaneously?

---

## Challenge 3: Concurrent Migration Race Conditions

```
Device A (offline): Runs app v2, sees workspace at v1
                    Starts migrating all rows...

Device B (offline): Runs app v2, sees workspace at v1
                    Also starts migrating all rows...

Both sync...
```

**Scenario A**: Deterministic migration
```typescript
// Both devices compute the same result
{ id: 'abc', status: 'pending' }  // Device A
{ id: 'abc', status: 'pending' }  // Device B (identical)

// YJS picks one. Doesn't matter which. Same data.
```

**Scenario B**: Non-deterministic migration
```typescript
// Devices compute different results
{ id: 'abc', migratedAt: '2024-01-24T10:00:00Z' }  // Device A
{ id: 'abc', migratedAt: '2024-01-24T10:05:00Z' }  // Device B (different!)

// YJS picks one. The other is lost. Data inconsistency.
```

**The constraint**: Migrations must be deterministic, or we need coordination.

---

## Challenge 4: Forward and Backward Compatibility

**Forward compatibility**: Old code reading new data
```
Device B (app v1) reads row created by Device A (app v2)
Row has fields Device B doesn't know about
```

What should happen? Crash? Ignore unknown fields? Block until update?

**Backward compatibility**: New code reading old data
```
Device A (app v2) reads row created months ago at v1
Row is missing fields that v2 expects
```

What should happen? Apply defaults? Error? Migrate in place?

---

## Challenge 5: Developer Experience

On top of all this, we want developers to not have to think about any of it.

**Current pain points:**

| Pain Point | Example |
|------------|---------|
| **Proprietary field syntax** | `text({ nullable: true })` instead of standard types |
| **Migration uncertainty** | "Should I bump epoch or add a field?" |
| **CRDT complexity leaks** | Developers need to understand Y.Map internals |
| **Type inference friction** | Multiple type definition layers |

**Goal**: A developer should be able to define their data model in 5 minutes and never think about CRDTs again (unless they want to).

---

## Summary: What We Need to Decide

| Question | Options |
|----------|---------|
| **LWW granularity** | Row-level (simpler) vs Cell-level (better merging) |
| **Version storage** | Per-workspace vs Per-row |
| **Migration trigger** | Eager (on startup) vs Lazy (on access) |
| **Migration coordination** | Any peer vs Designated migrator |
| **Schema definition** | Proprietary syntax vs Standard Schema (ArkType/Zod) |
| **Forward compat** | Ignore unknown vs Block until update |
| **Backward compat** | Defaults vs Explicit migration |

---

## Deep Dive: The Versioning Question

### Do We Even Need Framework-Level Versioning?

Let's think about this from first principles.

**What versioning buys you:**
- Automatic detection of "old" data
- Framework runs migrations for you
- Developers don't think about it

**What versioning costs you:**
- Complex coordination logic
- Race condition footguns
- Magic that's hard to debug
- Framework complexity

**Alternative: Invert control to the developer**

Instead of:
```typescript
// Framework magic
const store = defineStore('app')
  .v(1, schema1)
  .v(2, schema2, migrate)  // Framework handles when/how
  .build();
```

Maybe:
```typescript
// Developer controls migration
const store = defineStore('app', {
  tables: { recordings: RecordingSchema },
  kv: { theme: ThemeSchema },
});

// Developer decides when to migrate
if (needsMigration(workspace)) {
  await migrateRecordings(workspace);
}
```

### Let's Walk Through the Hard Cases

#### Case 1: Rename a Field (`text` → `title`)

```
BEFORE                          AFTER
┌─────────────────────┐        ┌─────────────────────┐
│ recordings          │        │ recordings          │
├─────────────────────┤        ├─────────────────────┤
│ abc: {              │   →    │ abc: {              │
│   id: "abc",        │        │   id: "abc",        │
│   text: "Hello"     │        │   title: "Hello"    │  ← renamed
│ }                   │        │ }                   │
└─────────────────────┘        └─────────────────────┘
```

**Migration code:**
```typescript
function migrateTextToTitle(workspace) {
  const table = workspace.doc.getMap('tables').get('recordings');

  for (const [id, rowJson] of table.entries()) {
    const row = JSON.parse(rowJson);
    if ('text' in row && !('title' in row)) {
      const migrated = { ...row, title: row.text };
      delete migrated.text;
      table.set(id, JSON.stringify(migrated));
    }
  }
}
```

**What if two peers migrate simultaneously?**

```
Timeline:
─────────────────────────────────────────────────────────────────
Device A (offline)     Device B (offline)     After Sync
─────────────────────────────────────────────────────────────────

Both start with:
{ id: "abc", text: "Hello" }

A reads row          B reads row
A transforms         B transforms
A writes:            B writes:
{                    {
  id: "abc",           id: "abc",
  title: "Hello"       title: "Hello"    ← SAME DATA
}                    }

                     SYNC
                       ↓

Result: { id: "abc", title: "Hello" }

YJS picks one write. Doesn't matter which.
Both wrote identical data. ✓ SAFE
```

**Key insight**: Deterministic transforms converge, even with concurrent execution.

#### Case 2: Rename a Table (`posts` → `articles`)

```
BEFORE                          AFTER
┌─────────────────────┐        ┌─────────────────────┐
│ tables              │        │ tables              │
├─────────────────────┤        ├─────────────────────┤
│ posts: Y.Map {      │        │ articles: Y.Map {   │  ← new name
│   abc: {...}        │   →    │   abc: {...}        │
│   def: {...}        │        │   def: {...}        │
│ }                   │        │ }                   │
│                     │        │ posts: Y.Map {}     │  ← old empty
└─────────────────────┘        └─────────────────────┘
```

**Migration code:**
```typescript
function migratePostsToArticles(workspace) {
  const tables = workspace.doc.getMap('tables');
  const oldTable = tables.get('posts');

  if (!oldTable || oldTable.size === 0) return; // Already migrated

  // Create new table if needed
  if (!tables.has('articles')) {
    tables.set('articles', new Y.Map());
  }
  const newTable = tables.get('articles');

  // Copy all rows
  for (const [id, rowJson] of oldTable.entries()) {
    if (!newTable.has(id)) {
      newTable.set(id, rowJson);
    }
  }

  // Clear old table (don't delete - other peers might still write to it)
  // Or: leave it, new code ignores it
}
```

**The concurrent migration scenario:**

```
Timeline:
─────────────────────────────────────────────────────────────────
Device A (offline)     Device B (offline)     After Sync
─────────────────────────────────────────────────────────────────

Both see posts with 2 rows, articles empty

A copies abc→articles  B copies abc→articles
A copies def→articles  B copies def→articles

                     SYNC
                       ↓

articles: { abc: {...}, def: {...} }

Both wrote same rows to same keys.
YJS merges. ✓ SAFE (if row content is identical)
```

#### Case 3: The Dangerous One - Non-Deterministic Transform

```typescript
// DANGEROUS: Each device computes different value
function migrateBad(workspace) {
  for (const [id, rowJson] of table.entries()) {
    const row = JSON.parse(rowJson);
    const migrated = {
      ...row,
      migratedAt: new Date().toISOString(),  // DIFFERENT ON EACH DEVICE
      migrationId: crypto.randomUUID(),       // DIFFERENT ON EACH DEVICE
    };
    table.set(id, JSON.stringify(migrated));
  }
}
```

```
Timeline:
─────────────────────────────────────────────────────────────────
Device A (offline)     Device B (offline)     After Sync
─────────────────────────────────────────────────────────────────

A writes:              B writes:
{                      {
  id: "abc",             id: "abc",
  migratedAt: "10:00",   migratedAt: "10:05",  ← DIFFERENT
  migrationId: "xxx"     migrationId: "yyy"    ← DIFFERENT
}                      }

                     SYNC
                       ↓

YJS picks ONE. Based on clientID ordering.
Could be A's version. Could be B's.
The other is LOST. ✗ DATA DIVERGENCE
```

### The ClientID Problem

YJS doesn't use wall-clock time for LWW. It uses internal operation ordering.

```
How YJS decides "last":
─────────────────────────────────────────────────────────────────

1. Each client has a unique clientID (random number)
2. Each operation gets a clock value (increments locally)
3. When two operations conflict, YJS compares:
   - First by clock value
   - Then by clientID (higher wins)

This means:
- "Last" is NOT chronological
- Device with higher clientID tends to win ties
- This is DETERMINISTIC (same result on all devices)
- But NOT intuitive (newer edit might lose)
```

**Why this matters for migrations:**

If Device A and B both write the SAME value:
- One wins, one loses
- Result is correct (values are identical)

If Device A and B write DIFFERENT values:
- One wins, one loses
- Result might not be what you expect
- The "older" edit (by wall clock) might win

### So... Do We Need Epochs?

Epochs (new Y.Doc for breaking changes) solve a different problem:

```
WITH EPOCHS:
─────────────────────────────────────────────────────────────────
Epoch 0 (Y.Doc)              Epoch 1 (Y.Doc)
┌──────────────────┐         ┌──────────────────┐
│ posts: {         │         │ articles: {      │
│   abc: {...}     │    →    │   abc: {...}     │
│ }                │  copy   │ }                │
└──────────────────┘         └──────────────────┘

- Old doc is frozen (read-only)
- New doc is fresh start
- No race conditions (migration runs once, copies data)
- Old clients stay on old epoch until they upgrade

WITHOUT EPOCHS (in-place migration):
─────────────────────────────────────────────────────────────────
Same Y.Doc
┌──────────────────┐         ┌──────────────────┐
│ posts: {         │         │ posts: {}        │
│   abc: {...}     │    →    │ articles: {      │
│ }                │ migrate │   abc: {...}     │
│                  │         │ }                │
└──────────────────┘         └──────────────────┘

- Same doc, modified in place
- Multiple peers can trigger migration
- Race conditions if transforms are non-deterministic
- Old clients see new data immediately (might break)
```

**When you need epochs:**
- Non-deterministic transforms
- Want old clients to stay isolated
- Clean break between schema versions

**When in-place migration is fine:**
- Deterministic transforms
- All clients will upgrade soon
- Additive changes (new fields, new tables)

### A Simpler Mental Model

What if we just accept:

1. **Additive changes** (add field, add table): Just do it. Old code ignores new stuff.

2. **Renames and restructures**: Developer writes migration function. It runs on each device. As long as it's deterministic, concurrent execution converges.

3. **Non-deterministic transforms**: Use epochs (new Y.Doc). Framework helps copy data.

```typescript
// The simple API
const store = defineStore('app', {
  tables: {
    recordings: RecordingSchema,
  },
});

// Additive: just add to schema, old data gets defaults on read
const storeV2 = defineStore('app', {
  tables: {
    recordings: RecordingSchemaV2, // Has new optional field
  },
});

// Restructure: developer runs migration explicitly
await store.migrate(async (doc) => {
  // Deterministic transform
  renameField(doc, 'recordings', 'text', 'title');
});

// Breaking: developer bumps epoch
await store.newEpoch(async (oldDoc, newDoc) => {
  // Can do non-deterministic stuff here
  // Runs on ONE device, new doc syncs to others
});
```

### The Real Question

Should the framework:

**Option A: Be smart (manage versions internally)**
- Track version in metadata
- Auto-run migrations
- Handle coordination
- Complex, magic, potential footguns

**Option B: Be simple (give developer control)**
- No version tracking
- Developer decides when to migrate
- Provide helpers, not magic
- Simple, explicit, developer owns the problem

**Option C: Hybrid**
- Track version for informational purposes
- Warn developer "workspace is at v1, code expects v2"
- Developer explicitly runs migration
- Best of both? Or worst of both?

---

## Design Philosophy

### 1. Schema-First, Not CRDT-First

Developers think in terms of their domain:

```typescript
// What developers WANT to write
type Recording = {
  id: string;
  title: string;
  transcript: string | null;
  duration: number;
  status: 'pending' | 'transcribed' | 'failed';
  createdAt: Date;
};
```

Not:

```typescript
// What they DON'T want to think about
const recording = Y.Map<{
  id: Y.Text,
  title: Y.Text,
  // ...
}>();
```

### 2. One Schema Definition, Multiple Uses

A single schema definition should power:
- TypeScript types (inference)
- Runtime validation
- YJS storage structure
- SQLite mirror (for queries)
- API contracts

### 3. Migrations Should Be Boring

The best migration system is one where:
- 90% of changes need no migration code
- The remaining 10% have one obvious path
- Breaking changes are rare and explicit

---

## Proposed API: ArkType-Native Schemas

### Basic Table Definition

```typescript
import { type } from 'arktype';
import { defineStore } from '@epicenter/workspace';

// Define your types using ArkType
const Recording = type({
  id: 'string',
  title: 'string',
  transcript: 'string | null',
  duration: 'number >= 0',
  status: "'pending' | 'transcribed' | 'failed'",
  createdAt: 'Date',
});

const Transformation = type({
  id: 'string',
  name: 'string',
  prompt: 'string',
  enabled: 'boolean',
});

// Define the store
const store = defineStore('whispering', {
  tables: {
    recordings: Recording,
    transformations: Transformation,
  },
  kv: {
    theme: type("'light' | 'dark'"),
    language: type("'en' | 'es' | 'fr' | 'de'"),
    autoSave: type('boolean'),
  },
});

// TypeScript infers everything
type RecordingRow = typeof store.tables.recordings.Row;
// { id: string; title: string; transcript: string | null; ... }
```

### Why ArkType?

| Feature | ArkType | Zod | TypeBox |
|---------|---------|-----|---------|
| **Type inference** | Excellent | Good | Good |
| **Runtime validation** | Fast | Moderate | Fast |
| **Syntax** | `'string | null'` | `z.string().nullable()` | `Type.Union(...)` |
| **Standard Schema** | Yes | Coming | No |
| **Bundle size** | Small | Moderate | Small |

ArkType's string-based syntax is closer to TypeScript itself, reducing cognitive load.

### Standard Schema Compatibility

If developers prefer Zod, Valibot, or other libraries:

```typescript
import { z } from 'zod';
import { defineStore, fromStandardSchema } from '@epicenter/workspace';

const Recording = z.object({
  id: z.string(),
  title: z.string(),
  transcript: z.string().nullable(),
  duration: z.number().min(0),
  status: z.enum(['pending', 'transcribed', 'failed']),
  createdAt: z.date(),
});

const store = defineStore('whispering', {
  tables: {
    // fromStandardSchema adapts any Standard Schema-compliant library
    recordings: fromStandardSchema(Recording),
  },
  kv: {},
});
```

---

## Storage Structure: Row-Level LWW

### Design Decision: Simplicity Over Granularity

We use **row-level last-write-wins** with a simple two-level structure:

```
Y.Map('tables')
  └── 'recordings': Y.Map<rowId, JSON string>
      ├── 'abc123': '{"id":"abc123","title":"Hello","status":"pending"}'
      └── 'def456': '{"id":"def456","title":"World","status":"done"}'

Y.Map('kv')
  ├── 'theme': '"dark"'
  └── 'language': '"en"'
```

**Why row-level, not cell-level?**

| Aspect | Row-Level LWW | Cell-Level LWW |
|--------|---------------|----------------|
| **Storage depth** | 2 levels | 3 levels |
| **Complexity** | Simple | Complex |
| **Serialization** | JSON.stringify | Field-by-field |
| **Conflict granularity** | Entire row | Per field |
| **Use case fit** | Single-user, low-collab | High-collaboration |

For most Epicenter apps (personal tools, single-user or family), row-level is the right trade-off. The simplicity wins.

### What This Means for Conflicts

```
Device A (offline): Edits title to "Hello"
Device B (offline): Edits status to "completed"
Both sync...

Result: ONE device's entire row wins.
        The other device's edit is lost.
```

**Mitigations:**

1. **Timestamps**: Store `updatedAt` in rows, surface "last editor" in UI
2. **Conflict detection**: Compare local vs synced, show indicator if different
3. **For high-collab needs**: Use a different storage mode (cell-level opt-in)

### Implementation

```typescript
// Writing a row
function upsert(row: Recording) {
  const tableMap = doc.getMap('tables').get('recordings') as Y.Map<string>;
  tableMap.set(row.id, JSON.stringify(row));
}

// Reading a row
function get(id: string): Recording | undefined {
  const tableMap = doc.getMap('tables').get('recordings') as Y.Map<string>;
  const json = tableMap.get(id);
  return json ? JSON.parse(json) : undefined;
}
```

This is deliberately simple. No nested Y.Maps, no field-level tracking.

---

## Migration Strategy: Strong Opinions

### The Golden Rule

> **Additive changes are free. Breaking changes cost an epoch.**

### What's "Additive"?

| Change Type | Additive? | Action Required |
|-------------|-----------|-----------------|
| Add nullable field | Yes | Nothing |
| Add field with default | Yes | Specify default |
| Add new table | Yes | Nothing |
| Add new KV key | Yes | Specify default |
| Rename field | **No** | Epoch bump |
| Change field type | **No** | Epoch bump |
| Remove field | **No** | Epoch bump (or soft deprecate) |
| Make nullable → required | **No** | Epoch bump |

### API for Schema Evolution

```typescript
const store = defineStore('whispering')
  // Version 1: Initial schema
  .schema({
    tables: {
      recordings: type({
        id: 'string',
        title: 'string',
        transcript: 'string | null',
      }),
    },
    kv: {
      theme: type("'light' | 'dark'"),
    },
  })

  // Version 2: Add fields (additive: no migration code!)
  .evolve({
    tables: {
      recordings: {
        // New fields with defaults
        status: { type: type("'pending' | 'transcribed'"), default: 'pending' },
        duration: { type: type('number'), default: 0 },
      },
    },
    kv: {
      // New KV with default
      language: { type: type("'en' | 'es' | 'fr'"), default: 'en' },
    },
  })

  // Version 3: Add computed field
  .evolve({
    tables: {
      recordings: {
        priority: {
          type: type('number'),
          // Compute from existing data when missing
          default: (row) => row.transcript ? 1 : 0,
        },
      },
    },
  })

  .build();
```

### What `.evolve()` Does

1. **Adds new fields** to the schema definition
2. **Stores defaults** for lazy migration
3. **Validates** that changes are additive
4. **Errors** if you try to do something breaking

```typescript
// This would ERROR at build time:
.evolve({
  tables: {
    recordings: {
      // ERROR: Cannot change type of existing field 'title'
      title: { type: type('number') },
    },
  },
})
```

### Breaking Changes: The Epoch Path

When you need to rename, retype, or restructure:

```typescript
import { createMigration } from '@epicenter/workspace';

// Step 1: Define migration
const migrationV2 = createMigration({
  from: store.v1,
  to: store.v2,

  tables: {
    recordings: (old) => ({
      ...old,
      // Rename: text → title
      title: old.text,
      // Type change: string → enum
      status: old.completed ? 'transcribed' : 'pending',
    }),
  },
});

// Step 2: Run migration (creates new epoch)
await workspace.migrateToEpoch(migrationV2);
```

**Important**: Breaking changes create a new Y.Doc. Old clients on old epochs can still read their data. They just won't see new data until they upgrade.

---

## Migration Coordination: The Hard Problem

### The Core Question

> If any peer can trigger a migration, how do we prevent chaos?

Consider this scenario:

```
Device A: Opens app (code expects v2), sees workspace at v1
Device A: Starts migrating all rows to v2...

Device B: Opens app (code expects v2), sees workspace at v1
Device B: Also starts migrating all rows to v2...

Both sync...

What happens?
```

### Where Is Version Stored?

**Option 1: Workspace Metadata (Single Source of Truth)**

```typescript
Y.Map('meta')
  ├── 'name': 'My Workspace'
  ├── 'schemaVersion': 2        // ← Single version for entire workspace
  └── 'migratedAt': '2024-01-24T16:30:00Z'
```

Pros:
- Clear, single source of truth
- Easy to check: `if (meta.get('schemaVersion') < targetVersion)`

Cons:
- Any peer can bump it
- Race condition window between "check version" and "write data"

**Option 2: Per-Row Version (Distributed)**

```typescript
// Each row has its own version
{ "id": "abc", "title": "Hello", "_v": 2 }
{ "id": "def", "title": "World", "_v": 1 }  // Not yet migrated
```

Pros:
- Gradual migration (rows upgrade when touched)
- No single point of contention

Cons:
- More complex to reason about
- "What version is my workspace?" has no clear answer
- Rows at different versions in same table

**Recommendation**: Workspace-level version in metadata, BUT with safe migration patterns.

### The Dexie Pattern: Read-Transform-Write

Dexie's IndexedDB migration works because:
1. Only ONE client opens the database at a time
2. Migrations run before the app starts
3. Version is stored in IndexedDB metadata

We can't have #1 (multiple peers), but we CAN adapt the pattern:

```typescript
// On client startup
async function initWorkspace(store: Store) {
  const meta = doc.getMap('meta');
  const currentVersion = meta.get('schemaVersion') ?? 1;
  const targetVersion = store.version;

  if (currentVersion >= targetVersion) {
    // Already migrated (by us or another peer)
    return;
  }

  // Run migration
  await runMigration(currentVersion, targetVersion);
}
```

### Safe Migration Protocol

**Key insight**: Migrations must be **idempotent** and **deterministic**.

```typescript
async function runMigration(from: number, to: number) {
  doc.transact(() => {
    const meta = doc.getMap('meta');
    const currentVersion = meta.get('schemaVersion') ?? 1;

    // Double-check inside transaction (another peer might have migrated)
    if (currentVersion >= to) {
      return; // Already done
    }

    // Migrate each table
    for (const [tableName, tableMap] of doc.getMap('tables').entries()) {
      for (const [rowId, rowJson] of (tableMap as Y.Map<string>).entries()) {
        const oldRow = JSON.parse(rowJson);
        const newRow = migrateRow(tableName, oldRow, from, to);

        // Only write if changed (idempotent)
        if (JSON.stringify(oldRow) !== JSON.stringify(newRow)) {
          tableMap.set(rowId, JSON.stringify(newRow));
        }
      }
    }

    // Bump version LAST (after all data migrated)
    meta.set('schemaVersion', to);
    meta.set('migratedAt', new Date().toISOString());
  });
}
```

**Why this is safe:**

1. **Check before migrate**: Skip if already at target version
2. **Transact**: All changes are atomic
3. **Idempotent transforms**: Same input → same output
4. **Deterministic**: No random values, no timestamps in data
5. **Version bumped last**: If migration fails, version stays old

### Race Condition Analysis

```
Device A: Reads version = 1
Device B: Reads version = 1
Device A: Starts migrating row "abc"
Device B: Starts migrating row "abc"
Both write: {"id":"abc","title":"Hello","status":"pending","_newField":"default"}
```

**Result**: Both devices write **identical data** (because migration is deterministic).
YJS picks one (doesn't matter which). No data corruption.

**The only danger**: Non-deterministic transforms.

```typescript
// DANGEROUS: Non-deterministic migration
const newRow = {
  ...oldRow,
  migratedAt: new Date(), // Different on each device!
  randomId: crypto.randomUUID(), // Different on each device!
};

// SAFE: Deterministic migration
const newRow = {
  ...oldRow,
  status: oldRow.completed ? 'done' : 'pending', // Same logic everywhere
  priority: 0, // Static default
};
```

### When Migrations MUST Be Coordinated

If you need non-deterministic transforms (rare), use **epoch bumps**:

```typescript
// Epoch migration: Creates entirely new Y.Doc
// Only the initiating device runs the transform
// Other devices just switch to the new epoch

await workspace.bumpEpoch({
  migrate: async (oldDoc, newDoc) => {
    // This runs on ONE device only
    for (const row of oldDoc.tables.recordings.getAll()) {
      newDoc.tables.recordings.upsert({
        ...row,
        // Safe to use non-deterministic values here
        migratedAt: new Date(),
      });
    }
  },
});
```

### Migration Timing Options

**Option A: Eager (On App Start)**

```typescript
// App startup
await client.ensureMigrated();
await client.whenReady;

// Now safe to use
```

Pros: Simple mental model
Cons: Startup delay, might migrate data user never touches

**Option B: Lazy (On First Access)**

```typescript
// Migration happens when you first read/write a table
const recordings = client.tables.recordings; // Triggers migration if needed
```

Pros: Faster startup, only migrate what's used
Cons: First operation is slow, harder to predict

**Option C: Hybrid (Metadata Eager, Data Lazy)**

```typescript
// On startup: Check version, prepare migration plan
await client.prepareMigration();

// On first table access: Run migration for that table
const recordings = client.tables.recordings;
```

**Recommendation**: Option A (Eager) for simplicity. Most apps have small datasets where migration is instant.

### What If Two Peers Have Different Code Versions?

```
Device A: Running app v2.0 (schema v3)
Device B: Running app v1.0 (schema v1)

Device A migrates workspace to v3.
Device B syncs, sees v3 data, but only understands v1 schema.
```

**Two strategies:**

**Strategy 1: Forward-Compatible Reads (Recommended)**

Device B ignores fields it doesn't understand:

```typescript
function parseRow(json: string, knownFields: string[]) {
  const row = JSON.parse(json);
  // Only extract fields this version knows about
  return Object.fromEntries(
    Object.entries(row).filter(([k]) => knownFields.includes(k))
  );
}
```

Device B can still read `id`, `title`. It ignores `newFieldFromV3`.

**Strategy 2: Schema Version Enforcement**

Device B refuses to operate on data newer than it understands:

```typescript
if (workspaceVersion > MY_MAX_VERSION) {
  throw new Error('Please update your app to access this workspace');
}
```

**Recommendation**: Strategy 1 by default (graceful degradation), Strategy 2 opt-in for critical apps.

### Summary: Migration Safety Rules

| Rule | Why |
|------|-----|
| **Migrations must be deterministic** | Same input → same output, regardless of which peer runs it |
| **Migrations must be idempotent** | Running twice produces same result as running once |
| **Check version before migrating** | Skip if already done |
| **Bump version after data** | Failed migration doesn't leave version in bad state |
| **No timestamps/random in transforms** | Use epoch bump if you need these |
| **Forward-compatible reads** | Old code ignores new fields |

---

## KV Store: Settings and Singletons

### Use Cases

- User preferences (theme, language)
- Feature flags
- App state that isn't per-record

### API

```typescript
const store = defineStore('whispering', {
  tables: { /* ... */ },
  kv: {
    theme: type("'light' | 'dark'"),
    language: type("'en' | 'es' | 'fr'"),
    lastSyncedAt: type('Date | null'),
    featureFlags: type({
      newEditor: 'boolean',
      betaFeatures: 'boolean',
    }),
  },
});

// Usage
const theme = store.kv.get('theme'); // 'light' | 'dark' | undefined
store.kv.set('theme', 'dark');

// With defaults
const themeWithDefault = store.kv.get('theme') ?? 'light';

// Observe changes
store.kv.observe('theme', (value) => {
  document.body.classList.toggle('dark', value === 'dark');
});
```

### KV vs Tables: When to Use What

| Use Case | KV | Table |
|----------|----|----|
| Single value (theme) | Yes | No |
| User preferences | Yes | No |
| List of items | No | Yes |
| Needs querying | No | Yes |
| Has relationships | No | Yes |

---

## Complete Example: Whispering App

```typescript
import { type } from 'arktype';
import { defineStore, createClient } from '@epicenter/workspace';

// ============================================
// SCHEMA DEFINITION
// ============================================

const Recording = type({
  id: 'string',
  title: 'string',
  transcript: 'string | null',
  duration: 'number >= 0',
  status: "'pending' | 'transcribed' | 'failed'",
  audioPath: 'string | null',
  createdAt: 'Date',
  updatedAt: 'Date',
});

const Transformation = type({
  id: 'string',
  name: 'string',
  prompt: 'string',
  enabled: 'boolean',
  order: 'number',
});

const store = defineStore('whispering')
  .schema({
    tables: {
      recordings: Recording,
      transformations: Transformation,
    },
    kv: {
      theme: type("'light' | 'dark' | 'system'"),
      transcriptionModel: type("'whisper-1' | 'whisper-large-v3'"),
      language: type("'en' | 'es' | 'fr' | 'de' | 'auto'"),
      autoTranscribe: type('boolean'),
    },
  })

  // Evolution: Add recording language detection
  .evolve({
    tables: {
      recordings: {
        detectedLanguage: { type: type('string | null'), default: null },
      },
    },
  })

  // Evolution: Add transformation categories
  .evolve({
    tables: {
      transformations: {
        category: { type: type("'formatting' | 'translation' | 'custom'"), default: 'custom' },
      },
    },
    kv: {
      showCategories: { type: type('boolean'), default: false },
    },
  })

  .build();

// ============================================
// USAGE
// ============================================

// Create client
const client = createClient(store, {
  providers: {
    indexeddb: true,
    // sync: 'wss://sync.epicenter.so/whispering',
  },
});

// Wait for local data to load
await client.whenReady;

// Tables API
const recordings = client.tables.recordings;

// Create
recordings.create({
  id: crypto.randomUUID(),
  title: 'Meeting Notes',
  transcript: null,
  duration: 0,
  status: 'pending',
  audioPath: '/recordings/meeting.webm',
  createdAt: new Date(),
  updatedAt: new Date(),
  detectedLanguage: null, // From evolution
});

// Read
const recording = recordings.get({ id: 'abc123' });
if (recording.status === 'valid') {
  console.log(recording.row.title);
}

// Update (patches only changed fields: cell-level LWW safe)
recordings.update({
  id: 'abc123',
  status: 'transcribed',
  transcript: 'Hello, world...',
  updatedAt: new Date(),
});

// Query all
const allRecordings = recordings.getAll();
const pendingCount = allRecordings.filter(r => r.status === 'pending').length;

// Observe changes
recordings.observe((changedIds) => {
  console.log('Recordings changed:', changedIds);
});

// KV API
const theme = client.kv.get('theme') ?? 'system';
client.kv.set('autoTranscribe', true);

client.kv.observe('theme', (newTheme) => {
  applyTheme(newTheme);
});
```

---

## Type Inference Deep Dive

### From Schema to TypeScript Types

```typescript
const store = defineStore('app', {
  tables: {
    recordings: type({
      id: 'string',
      title: 'string',
      duration: 'number',
    }),
  },
  kv: {
    theme: type("'light' | 'dark'"),
  },
});

// Inferred types
type Store = typeof store;

// Table row type
type RecordingRow = Store['tables']['recordings']['Row'];
// { id: string; title: string; duration: number }

// KV value types
type Theme = Store['kv']['theme']['Value'];
// 'light' | 'dark'

// Full store type (for passing around)
type AppStore = typeof store;
```

### Why This Matters

1. **No duplicate type definitions**: the schema IS the type
2. **Autocomplete everywhere**: IDE knows your fields
3. **Refactor safety**: rename a field, see all usages

---

## Migration Internals (Implementation Notes)

### How Read-Time Migration Works

When reading a row, we apply schema defaults **in memory only**:

```typescript
// Internal: what happens on read
function getRow(id: string): Recording {
  const tableMap = doc.getMap('tables').get('recordings') as Y.Map<string>;
  const json = tableMap.get(id);
  if (!json) return undefined;

  const raw = JSON.parse(json);

  // Apply defaults for missing fields (from .evolve() definitions)
  for (const [field, config] of store.evolutions) {
    if (!(field in raw)) {
      raw[field] = typeof config.default === 'function'
        ? config.default(raw)
        : config.default;
    }
  }

  // Validate against current schema
  const validated = store.schema.recordings(raw);
  if (validated instanceof type.errors) {
    return { status: 'invalid', errors: validated };
  }

  return { status: 'valid', row: validated };
}
```

**Key point**: The Y.Doc is NOT modified during reads. Old data stays old until explicitly written.

### When Data Gets Persisted with New Fields

**Option A: On User Edit**

When a user edits any field, we persist the full migrated row:

```typescript
function update(id: string, changes: Partial<Recording>) {
  doc.transact(() => {
    const tableMap = doc.getMap('tables').get('recordings') as Y.Map<string>;

    // Read current row (with in-memory defaults applied)
    const current = getRow(id);
    if (current.status !== 'valid') {
      throw new Error('Cannot update invalid row');
    }

    // Merge changes
    const updated = { ...current.row, ...changes };

    // Write full row (now includes any new fields)
    tableMap.set(id, JSON.stringify(updated));
  });
}
```

**Option B: Explicit Migration (Batch)**

Developer explicitly migrates all data:

```typescript
await client.migrateAllRows();

// Internal implementation
function migrateAllRows() {
  doc.transact(() => {
    for (const [tableName, tableMap] of doc.getMap('tables').entries()) {
      for (const [rowId, rowJson] of (tableMap as Y.Map<string>).entries()) {
        const migrated = applyMigrations(tableName, JSON.parse(rowJson));
        const newJson = JSON.stringify(migrated);

        // Only write if actually changed
        if (rowJson !== newJson) {
          tableMap.set(rowId, newJson);
        }
      }
    }
  });
}
```

### Preventing Double-Migration Data Corruption

**The Danger:**

```
Device A: Sees old data, runs migration, writes transformed rows
Device B: Sees old data, runs migration, writes transformed rows
Both sync...

If transforms are deterministic: Both write same data. Safe.
If transforms are NOT deterministic: Data diverges. One version lost.
```

**Protection Layer 1: Workspace Version Check**

```typescript
function migrateIfNeeded() {
  const meta = doc.getMap('meta');
  const currentVersion = meta.get('schemaVersion') ?? 1;

  if (currentVersion >= store.targetVersion) {
    // Another peer already migrated. Nothing to do.
    return;
  }

  // Proceed with migration...
}
```

**Protection Layer 2: Content-Based Skip**

```typescript
function migrateRow(tableName: string, oldRow: any): any {
  const newRow = applyTransforms(oldRow);

  // If nothing changed, return original (won't trigger write)
  if (JSON.stringify(oldRow) === JSON.stringify(newRow)) {
    return oldRow;
  }

  return newRow;
}
```

**Protection Layer 3: Deterministic-Only Transforms**

The `.evolve()` API only allows defaults, not arbitrary transforms:

```typescript
// This is ALLOWED (deterministic)
.evolve({
  tables: {
    recordings: {
      status: { type: type("'pending' | 'done'"), default: 'pending' },
    },
  },
})

// This would be REJECTED (non-deterministic)
.evolve({
  tables: {
    recordings: {
      migratedAt: { type: type('Date'), default: () => new Date() }, // ERROR!
    },
  },
})
```

For non-deterministic transforms, use epoch bumps (separate Y.Doc, no race condition).

---

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **LWW granularity** | Row-level | Simpler (2 levels), good enough for single-user/low-collab |
| **Storage format** | JSON string per row | Easy serialize/deserialize, schema-agnostic |
| **Schema library** | ArkType (Standard Schema compat) | Clean syntax, good inference, industry standard |
| **Version storage** | Workspace metadata | Single source of truth, easy to check |
| **Migration trigger** | Any peer can initiate | Must be deterministic to be safe |

---

## Open Questions

### 1. Should computed defaults be allowed?

```typescript
.evolve({
  tables: {
    recordings: {
      // Is this okay? It's deterministic (same row → same result)
      priority: { type: type('number'), default: (row) => row.transcript ? 1 : 0 },
    },
  },
})
```

**Concern**: Even deterministic computed defaults could cause issues if the input row is in an unexpected state.

**Leaning**: Allow, but document that function must be pure (no side effects, no external state).

### 2. How to handle failed partial migrations?

```
Device A starts migrating 1000 rows.
After 500 rows, connection drops.
Device A comes back online.
```

**Options**:
- A: Re-run migration from scratch (idempotent, so safe)
- B: Track progress per-row with `_migrated` flag
- C: Use version per-row instead of per-workspace

**Leaning**: Option A. For most apps, re-running is instant. For huge datasets, we can add progress tracking later.

### 3. Should old app versions be blocked or degraded?

When Device B (old code) encounters data from Device A (new code):

**Option A: Graceful degradation**
```typescript
// Old code just ignores fields it doesn't know
const { id, title } = JSON.parse(rowJson);
// `newFieldFromV3` is silently dropped
```

**Option B: Block with upgrade prompt**
```typescript
if (workspaceVersion > MAX_SUPPORTED_VERSION) {
  throw new Error('Please update to continue');
}
```

**Leaning**: Option A by default. Let developers opt into Option B.

### 4. What about arrays in rows?

```typescript
const Playlist = type({
  id: 'string',
  name: 'string',
  trackIds: 'string[]', // Row-level LWW means concurrent edits to array are lost
});
```

**Options**:
- A: Accept it (arrays are LWW, last write wins)
- B: Normalize to separate table (`playlist_tracks` with `playlistId`, `trackId`, `order`)
- C: Expose Y.Array for this field (leaks CRDT complexity)

**Leaning**: Option A for simple cases, document Option B as best practice for frequently-edited lists.

### 5. Should there be a cell-level mode for high-collaboration?

```typescript
// Opt-in per table?
const store = defineStore('collab-notes', {
  tables: {
    notes: {
      schema: NoteSchema,
      conflictMode: 'cell', // Use Y.Map per field instead of JSON string
    },
  },
});
```

**Concern**: Two storage modes = two code paths = complexity.

**Leaning**: Defer. Start with row-level only. Add cell-level if users request it.

### 6. Rich text handling?

Current approach: Separate Y.Doc per rich text field, referenced by ID.

**Question**: Should this be exposed in the schema API?

```typescript
const Note = type({
  id: 'string',
  title: 'string',
  content: 'richtext', // Magic type that creates separate Y.Doc
});

// Usage
const content = client.richtext.get(note.content); // Returns Y.XmlFragment
```

**Leaning**: Yes, but as a separate API. Rich text is fundamentally different (collaborative editing within a field).

---

## Success Criteria

- [ ] Developer can define a schema in < 5 minutes
- [ ] Schema changes for 90% of use cases require no migration code
- [ ] Breaking changes have a clear, documented path
- [ ] TypeScript autocomplete works everywhere
- [ ] No CRDT concepts leak into the API (unless developer opts in)
- [ ] Existing ArkType/Zod users feel at home

---

## Next Steps

1. **Prototype** the `defineStore` API with ArkType
2. **Test** type inference with complex schemas
3. **Benchmark** validation performance
4. **Document** the migration decision tree
5. **Implement** Standard Schema adapter

---

## Related Documents

- `specs/20260124T125300-workspace-schema-versioning.md`: Workspace-level versioning details
- `specs/20260124T004528-versioned-table-api-design.md`: YJS conflict analysis
- `packages/epicenter/src/core/schema/fields/types.ts`: Current field system

---

## Changelog

- 2026-01-24: Initial draft focusing on DX with ArkType-native schemas
