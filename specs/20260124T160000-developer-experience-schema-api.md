# Developer Experience for YJS-Backed Tables and KV

> **⚠️ PARTIALLY SUPERSEDED**
>
> The migration strategy in this spec has been superseded by [`specs/20260124T162638-stable-id-schema-pattern.md`](./20260124T162638-stable-id-schema-pattern.md).
>
> **What's still valuable here**:
> - Part 1: Schema Definition DX (field factories like `text()`, `select()`)
> - Part 2: Cell-Level vs Row-Level LWW analysis
> - The patch-based update pattern
>
> **What's obsolete**:
> - Part 3-4: The `_v` versioning and migration strategy
> - The `since` and `migrateFrom` field options
> - Lazy migration on read/write
>
> **The new approach**: Each field has a stable `id` that never changes. Renaming is free. Invalid data returns the default. No migrations needed.

---

**Status**: Draft (Partially Superseded)
**Date**: 2026-01-24
**Context**: Designing the ideal developer experience for defining schemas, tables, and KV stores with YJS, focusing on migrations and conflict handling
**Builds on**: `specs/20260124T004528-versioned-table-api-design.md`, `specs/20260124T125300-workspace-schema-versioning.md`, `specs/20260116T082500-schema-migration-patterns.md`

---

## Executive Summary

This spec focuses on **developer experience** (DX): What do developers actually type? How do they define schemas, handle migrations, and avoid data loss from concurrent edits?

**Key decisions proposed**:

1. **Standard Schema for field definitions** (not proprietary syntax)
2. **Cell-level LWW** as the default (not row-level)
3. **Additive-only migrations** within epochs (breaking changes = epoch bump)
4. **Lazy migration on read**, explicit migration on write
5. **Simple versioned workspace API** with callback-based schema evolution

---

## Part 1: Schema Definition DX

### The Question

Should we use proprietary field syntax (`text()`, `select()`) or standard schemas (ArkType, Standard Schema, TypeBox)?

### Analysis: Proprietary vs Standard

| Aspect | Proprietary (`text()`, `select()`) | Standard Schema (ArkType, TypeBox) |
|--------|-------------------------------------|-------------------------------------|
| **Learning curve** | New API to learn | Use existing knowledge |
| **Type inference** | Custom inference | Built-in inference |
| **Validation** | Custom validators | Well-tested validators |
| **Ecosystem** | Isolated | Integrates with tRPC, Hono, etc. |
| **Flexibility** | Limited to our types | Full schema power |
| **UI metadata** | Native (`name`, `icon`) | Needs extension |

### Recommendation: Hybrid Approach

Use **Standard Schema-compatible types** with **metadata extensions** for UI:

```typescript
import { type } from 'arktype';

// Option A: ArkType with metadata decorators (proposed)
const Recording = type({
  id: 'string',
  title: 'string',
  transcript: 'string | null',
  status: "'pending' | 'transcribing' | 'completed'",
  duration: 'number',
  createdAt: 'string', // ISO timestamp
});

// Metadata separate (keeps schema portable)
const recordingsTable = defineTable({
  name: 'Recordings',
  icon: 'emoji:🎙️',
  schema: Recording,
  primaryKey: 'id',
});
```

```typescript
// Option B: Keep current factory syntax (familiar, metadata inline)
import { table, id, text, select, integer } from '@epicenter/workspace';

const recordingsTable = table({
  name: 'Recordings',
  icon: '🎙️',
  fields: {
    id: id(),
    title: text(),
    transcript: text({ nullable: true }),
    status: select({ options: ['pending', 'transcribing', 'completed'] }),
    duration: integer(),
    createdAt: text(),
  },
});
```

**Verdict**: Keep **Option B (current syntax)** for several reasons:

1. **Metadata co-location**: Name, icon, description live with the field
2. **Type inference**: Factory functions provide excellent inference
3. **Simplicity**: No need to learn ArkType syntax
4. **YJS-aware**: Fields know their CRDT implications (e.g., `richtext` creates separate Y.Doc)
5. **Conversion available**: Can still export to ArkType/TypeBox/JSON Schema via converters

The current `text()`, `select()`, `integer()` factories are good DX. The spec should focus on **versioning** and **migrations**, not replacing the field system.

---

## Part 2: Cell-Level vs Row-Level LWW

### The Core Problem

YJS Y.Map uses **last-write-wins per key (cell)**. This creates problems:

```
Device A: Sets row { id: '1', title: 'Hello', status: 'draft' }
Device B: Sets row { id: '1', title: 'World', status: 'draft' }
Sync...

Result: { id: '1', title: ??? (one wins), status: 'draft' }
```

If both devices set the entire row, they compete on EVERY field. YJS picks one writer per field based on client ID ordering.

### Two Approaches

#### Row-Level: Full Row Operations

```typescript
// Every write sets all fields
table.upsert({ id: '1', title: 'Hello', status: 'draft' });

// Internally:
ymap.set('1/id', '1');
ymap.set('1/title', 'Hello');
ymap.set('1/status', 'draft');
```

**Problem**: Writing `title` also writes `status`. If another device changed `status`, your write to `title` clobbers it.

#### Cell-Level: Patch Operations

```typescript
// Only write fields that changed
table.update({ id: '1', title: 'Hello' }); // Only touches 'title'

// Internally:
ymap.set('1/title', 'Hello'); // Only this field
```

**Benefit**: Concurrent edits to different fields merge correctly.

### Recommendation: Cell-Level by Default

For most apps (like Whispering), **cell-level editing** is correct:

1. **Concurrent safety**: Two devices editing different fields don't conflict
2. **Minimal writes**: Only changed data hits the network
3. **Natural model**: Matches how users think about edits

**API implication**: The `update()` method should be patch-based, not full-row:

```typescript
// GOOD: Only writes 'title'
table.update({ id: '1', title: 'New Title' });

// BAD: Writes ALL fields, clobbering concurrent edits to other fields
table.upsert(table.get('1').merge({ title: 'New Title' }));
```

### When Row-Level Makes Sense

Row-level is appropriate for:

1. **Immutable records**: Append-only data (logs, events)
2. **User-initiated saves**: Explicit "save" button, no concurrent editing
3. **Transactional integrity**: All fields must be consistent (financial records)

For Whispering's recordings table: **cell-level** is correct. Recordings are mostly immutable after creation, but metadata (title, tags) can be edited independently.

---

## Part 3: Migration Strategy

### The Migration Problem

Local-first apps face unique migration challenges:

1. **No migration window**: Old and new app versions coexist indefinitely
2. **Offline devices**: Devices may sync months later
3. **No central coordinator**: Can't run migrations "at deploy time"
4. **Data arrives from anywhere**: Any peer can send any version

### The Two-Tier Strategy (Already Established)

Your existing specs establish the right pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│  EPOCH (Breaking Changes)                                        │
│  ─────────────────────────                                       │
│  • Field renames: text → title                                  │
│  • Type changes: string → number                                │
│  • Field deletions                                              │
│  • Major restructuring                                          │
│                                                                  │
│  Action: Bump epoch, migrate to new Y.Doc                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Within each epoch...
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  SCHEMA VERSION (Additive Changes)                               │
│  ─────────────────────────────────                               │
│  • Add nullable field                                           │
│  • Add field with default                                       │
│  • Add computed field                                           │
│  • Add new table                                                │
│                                                                  │
│  Action: Lazy migrate on read, explicit migrate on write        │
└─────────────────────────────────────────────────────────────────┘
```

### What Developers Actually Type

#### Defining a Versioned Workspace

```typescript
import { defineWorkspace, table, id, text, select, integer, setting } from '@epicenter/workspace';

// Version 1: Initial schema
const whisperingV1 = {
  tables: {
    recordings: table({
      name: 'Recordings',
      icon: '🎙️',
      fields: {
        id: id(),
        title: text(),
        transcript: text({ nullable: true }),
      },
    }),
    transformations: table({
      name: 'Transformations',
      icon: '✨',
      fields: {
        id: id(),
        name: text(),
        prompt: text(),
      },
    }),
  },
  kv: {
    theme: setting({ name: 'Theme', field: select({ options: ['light', 'dark'], default: 'light' }) }),
  },
};

// Version 2: Add status to recordings, add language setting
const whisperingV2 = {
  tables: {
    recordings: table({
      name: 'Recordings',
      icon: '🎙️',
      fields: {
        id: id(),
        title: text(),
        transcript: text({ nullable: true }),
        // NEW: status field with default
        status: select({ options: ['pending', 'completed'], default: 'completed' }),
      },
    }),
    transformations: table({
      name: 'Transformations',
      icon: '✨',
      fields: {
        id: id(),
        name: text(),
        prompt: text(),
        // NEW: enabled toggle
        enabled: boolean({ default: true }),
      },
    }),
  },
  kv: {
    theme: setting({ name: 'Theme', field: select({ options: ['light', 'dark'], default: 'light' }) }),
    // NEW: language setting
    language: setting({ name: 'Language', field: select({ options: ['en', 'es', 'fr'], default: 'en' }) }),
  },
};

export const whisperingWorkspace = defineWorkspace({
  id: 'epicenter.whispering',
  versions: [
    { version: 1, schema: whisperingV1 },
    { version: 2, schema: whisperingV2 },
  ],
});
```

**Key points**:
- Each version is a complete schema snapshot
- New fields MUST have defaults (for migration)
- No explicit migration functions for additive changes. Defaults are sufficient

#### Alternative: Callback-Based Evolution (More Explicit)

```typescript
export const whisperingWorkspace = workspace('epicenter.whispering')
  .v(1, whisperingV1)
  .v(2, (prev) => ({
    tables: {
      recordings: table({
        ...prev.tables.recordings,
        fields: {
          ...prev.tables.recordings.fields,
          status: select({
            options: ['pending', 'completed'],
            default: 'completed',
            // Optional: compute from existing data
            migrateFrom: (row) => row.transcript ? 'completed' : 'pending',
          }),
        },
      }),
      transformations: table({
        ...prev.tables.transformations,
        fields: {
          ...prev.tables.transformations.fields,
          enabled: boolean({ default: true }),
        },
      }),
    },
    kv: {
      ...prev.kv,
      language: setting({
        name: 'Language',
        field: select({ options: ['en', 'es', 'fr'], default: 'en' })
      }),
    },
  }))
  .build();
```

**This approach** (from your `20260124T125300` spec) is powerful but verbose.

### Recommended API: Declarative with Computed Defaults

```typescript
export const whisperingWorkspace = defineWorkspace({
  id: 'epicenter.whispering',
  currentVersion: 2,

  tables: {
    recordings: table({
      name: 'Recordings',
      icon: '🎙️',
      fields: {
        id: id(),
        title: text(),
        transcript: text({ nullable: true }),
        // Added in v2
        status: select({
          options: ['pending', 'completed'],
          // Simple default
          default: 'completed',
          // OR: Computed migration (optional)
          migrateFrom: (row) => row.transcript ? 'completed' : 'pending',
          // When was this field added?
          since: 2,
        }),
      },
    }),
    transformations: table({
      name: 'Transformations',
      icon: '✨',
      fields: {
        id: id(),
        name: text(),
        prompt: text(),
        enabled: boolean({ default: true, since: 2 }),
      },
    }),
  },

  kv: {
    theme: setting({
      name: 'Theme',
      field: select({ options: ['light', 'dark'], default: 'light' })
    }),
    language: setting({
      name: 'Language',
      field: select({ options: ['en', 'es', 'fr'], default: 'en' }),
      since: 2,
    }),
  },
});
```

**This API**:
1. Keeps the schema in one place (not scattered across version callbacks)
2. Uses `since` to track when fields were added
3. Uses `default` for simple migrations, `migrateFrom` for computed
4. Is closer to how developers think: "what's the current schema?"

---

## Part 4: Runtime Behavior

### Reading Rows (Lazy Migration)

```typescript
function get(id: string): Recording | null {
  const raw = ymap.get(id)?.toJSON();
  if (!raw) return null;

  // Apply in-memory migration (does NOT write back)
  const version = raw._v ?? 1;
  if (version < currentVersion) {
    return migrate(raw, version, currentVersion);
  }

  return raw as Recording;
}

function migrate(row: any, fromVersion: number, toVersion: number): Recording {
  let current = { ...row };

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    if (fieldDef.since && fieldDef.since > fromVersion && !(fieldName in current)) {
      // Apply default or computed value
      current[fieldName] = fieldDef.migrateFrom
        ? fieldDef.migrateFrom(current)
        : fieldDef.default;
    }
  }

  current._v = toVersion;
  return current;
}
```

### Writing Rows (YJS-Safe Patching)

```typescript
function update(partial: Partial<Recording> & { id: string }): void {
  ydoc.transact(() => {
    const rowMap = getOrCreateRowMap(partial.id);
    const currentVersion = rowMap.get('_v') ?? 1;

    // 1. Migrate new fields if needed (YJS-safe: only add missing fields)
    if (currentVersion < schemaVersion) {
      for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
        if (fieldDef.since && fieldDef.since > currentVersion && !rowMap.has(fieldName)) {
          const value = fieldDef.migrateFrom
            ? fieldDef.migrateFrom(rowMap.toJSON())
            : fieldDef.default;
          rowMap.set(fieldName, value);
        }
      }
      rowMap.set('_v', schemaVersion);
    }

    // 2. Apply user's changes (only the fields they provided)
    for (const [key, value] of Object.entries(partial)) {
      if (key !== 'id' && key !== '_v') {
        rowMap.set(key, value);
      }
    }
  });
}
```

### Creating New Rows

```typescript
function insert(row: Omit<Recording, 'id'> & { id?: string }): Recording {
  const id = row.id ?? generateId();

  ydoc.transact(() => {
    const rowMap = new Y.Map();

    // Set all fields at current version
    rowMap.set('id', id);
    for (const [fieldName, value] of Object.entries(row)) {
      if (fieldName !== 'id') {
        rowMap.set(fieldName, value);
      }
    }
    rowMap.set('_v', schemaVersion);

    tableMap.set(id, rowMap);
  });

  return { ...row, id, _v: schemaVersion } as Recording;
}
```

---

## Part 5: Handling Concurrent Conflicts

### The Danger Zone: Migration + Concurrent Edit

```
Device A (offline): Reads row v1, app migrates to v2 in memory
                   User edits title
                   App writes row with ALL fields (bad pattern)

Device B (offline): User edits status on v1

Sync... → Title OR status may be lost (YJS picks per-field winner)
```

### The Safe Pattern

**Never write fields you didn't change.**

```typescript
// GOOD: Only write what the user changed
function updateTitle(id: string, newTitle: string) {
  ydoc.transact(() => {
    const rowMap = tableMap.get(id);

    // Migrate if needed (adds NEW fields only)
    ensureMigrated(rowMap);

    // Only write the title
    rowMap.set('title', newTitle);
  });
}

// BAD: Write entire row
function updateTitle(id: string, newTitle: string) {
  const row = get(id); // Returns migrated row
  row.title = newTitle;

  // This writes EVERY field, competing with concurrent edits
  upsert(row);
}
```

### API Design Implications

The table API should encourage patch-based updates:

```typescript
// Primary API: patch-based update
table.update({ id: '1', title: 'New Title' }); // Only touches 'title'

// Secondary API: full row (use with caution)
table.upsert(fullRow); // Writes all fields - documented as "clobbers concurrent edits"

// Read API: returns migrated row (in-memory, no write)
const row = table.get('1'); // Always at current schema version
```

---

## Part 6: Forward Compatibility

### Old Client Reads New Data

Device A (v2) creates a row with `status` field.
Device B (v1) syncs and reads it.

```typescript
// Device B's code (v1 schema, doesn't know about 'status')
const row = table.get('1');
// row = { id: '1', title: 'Hello', status: 'completed', _v: 2 }

// Device B's validator only knows v1 fields
// BUT: we must preserve unknown fields!
```

**Rule**: Old clients must preserve unknown fields when writing:

```typescript
function update(partial: Partial<Row> & { id: string }) {
  ydoc.transact(() => {
    const rowMap = tableMap.get(partial.id);

    // Only update fields we're changing
    // Unknown fields (like 'status' for v1 client) remain untouched
    for (const [key, value] of Object.entries(partial)) {
      if (key !== 'id') {
        rowMap.set(key, value);
      }
    }
    // Don't downgrade _v - old client doesn't touch it
  });
}
```

### New Client Reads Old Data

Device A (v1) has a row without `status`.
Device B (v2) reads it.

```typescript
// Device B's code
const row = table.get('1');
// In-memory migration applies: row.status = 'completed' (default)
// BUT: this is NOT written back to YJS unless user edits
```

**Decision**: Do NOT eagerly write migrations back. Wait for user edit.

---

## Part 7: Breaking Changes (Epoch Bumps)

### When Epochs Are Required

1. **Field rename**: `text` → `title`
2. **Type change**: `views: string` → `views: number`
3. **Field deletion**: Remove `deprecated_field`
4. **Incompatible schema change**: Split one field into multiple

### Epoch Migration Script

```typescript
// Migration from epoch 0 to epoch 1
// This runs ONCE, coordinated (e.g., on first launch after update)

async function migrateEpoch0ToEpoch1() {
  const head = await getHeadDoc('epicenter.whispering');
  const currentEpoch = head.getEpoch(); // 0

  if (currentEpoch !== 0) {
    console.log('Already migrated');
    return;
  }

  // Create clients at both epochs
  const oldClient = await createClient({ epoch: 0 });
  const newClient = await createClient({ epoch: 1 });

  // Migrate recordings table
  for (const recording of oldClient.tables.recordings.getAll()) {
    newClient.tables.recordings.upsert({
      ...recording,
      // Apply breaking changes
      title: recording.text,  // Rename: text → title
      // text field no longer exists in v1 schema
    });
  }

  // Copy other tables...

  // Bump epoch (atomic switch)
  head.bumpEpoch();

  // Cleanup
  await oldClient.destroy();
  await newClient.destroy();
}
```

### Key Points

1. **New Y.Doc**: Epoch 1 is a completely new document
2. **Full transform safe**: No concurrent edits to new doc yet
3. **Old data preserved**: Epoch 0 doc still exists for rollback
4. **Coordinated**: Only one device runs migration, others see epoch bump

---

## Part 8: Decision Summary

| Question | Decision | Rationale |
|----------|----------|-----------|
| **Field definition syntax** | Keep `text()`, `select()` factories | Good DX, type inference, metadata co-location |
| **Schema standard** | Internal format with converters | Can export to ArkType/TypeBox/JSON Schema on demand |
| **Cell vs Row LWW** | Cell-level by default | Preserves concurrent edits to different fields |
| **Primary update API** | Patch-based `update()` | Only touches changed fields |
| **Migration timing** | Lazy on read, explicit on write | Minimal YJS writes, preserves concurrent edits |
| **Version storage** | Per-row `_v` field | Gradual migration, handles mixed versions |
| **Breaking changes** | Epoch bump | Clean slate, no conflict with old data |
| **Forward compat** | Preserve unknown fields | Old clients don't clobber new fields |

---

## Part 9: API Reference (Proposed)

### Workspace Definition

```typescript
import {
  defineWorkspace,
  table,
  setting,
  id, text, select, integer, boolean, date, tags, richtext
} from '@epicenter/workspace';

export const myWorkspace = defineWorkspace({
  id: 'my.workspace',
  version: 2, // Current schema version

  tables: {
    items: table({
      name: 'Items',
      icon: '📦',
      description: 'All items in the system',
      fields: {
        id: id(),
        title: text(),
        description: text({ nullable: true }),
        status: select({
          options: ['draft', 'active', 'archived'],
          default: 'draft',
        }),
        priority: integer({
          default: 0,
          since: 2, // Added in version 2
        }),
        tags: tags({ default: [] }),
        createdAt: date(),
        notes: richtext(), // Separate Y.Doc for rich content
      },
    }),
  },

  kv: {
    theme: setting({
      name: 'Theme',
      field: select({ options: ['light', 'dark'], default: 'light' }),
    }),
    autoSave: setting({
      name: 'Auto-save',
      field: boolean({ default: true }),
      since: 2,
    }),
  },
});
```

### Table Operations

```typescript
const client = await createClient(myWorkspace);
const { items } = client.tables;

// Create (all fields at current version)
const item = items.insert({
  title: 'New Item',
  status: 'draft',
  priority: 1,
  tags: ['important'],
  createdAt: new Date().toISOString(),
});

// Read (automatically migrated to current version)
const existing = items.get({ id: 'abc' });
if (existing.status === 'valid') {
  console.log(existing.row.priority); // Works even if row was created at v1
}

// Update (patch-based, only touches specified fields)
items.update({ id: 'abc', title: 'Updated Title' });

// Upsert (full row, use with caution in concurrent scenarios)
items.upsert({ id: 'abc', ...fullRow });

// Delete
items.delete({ id: 'abc' });

// List
const all = items.getAll(); // Returns array of migrated rows
```

### KV Operations

```typescript
const { kv } = client;

// Get (returns default if not set)
const theme = kv.get('theme'); // 'light' | 'dark'

// Set
kv.set('theme', 'dark');

// Subscribe
kv.subscribe('theme', (value) => {
  console.log('Theme changed:', value);
});
```

---

## Open Questions for Discussion

1. **Should `since` be required for new fields?**
   - Pro: Explicit about migration needs
   - Con: Verbose for simple schemas

2. **Should computed migrations (`migrateFrom`) write back immediately?**
   - Current proposal: No, only on user edit
   - Alternative: Write back in background after sync

3. **How to handle `richtext` field migrations?**
   - Rich text is a separate Y.Doc
   - Might need special handling for content migrations

4. **Should we expose version history in the API?**
   - `table.getVersionHistory(id)`: useful for debugging?

5. **How to handle schema validation errors?**
   - Current: Return `{ status: 'invalid', errors }` from `get()`
   - Should invalid rows be auto-repaired? Hidden? Surfaced to user?

---

## Related Documents

- `specs/20260124T004528-versioned-table-api-design.md`: Deep dive on row versioning
- `specs/20260124T125300-workspace-schema-versioning.md`: Workspace-level versioning
- `specs/20260116T082500-schema-migration-patterns.md`: Migration strategy overview
- `apps/whispering/src/lib/services/isomorphic/db/models/transformation-steps.ts`: Real example of ArkType versioned schema

---

## Changelog

- 2026-01-24: Initial draft focusing on developer experience
