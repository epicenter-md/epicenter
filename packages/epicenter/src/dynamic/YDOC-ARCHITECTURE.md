# Y.Doc Architecture: Three Documents, One Client

> **⚠️ ARCHIVED DOCUMENTATION**
>
> This document describes the **three-document architecture** (Registry → HeadDoc → Workspace)
> which is planned for future **versioned workspaces** with epoch-based versioning, snapshots,
> and time-travel capabilities.
>
> **Current implementation uses the simpler definition-first pattern:**
>
> - See `workspace/README.md` for the current simple API
> - See `docs/articles/archived-head-registry-patterns.md` for preserved implementation details
>
> This architecture will be implemented when `versionControl: true` workspaces are added.

This module provides typed wrappers for the Y.Doc types that power collaborative workspaces.

## Summary: The Three-Fetch Pattern

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   STEP 1               STEP 2                STEP 3                         │
│   Registry Doc         Head Doc              createClient()                 │
│   ────────────         ────────              ──────────────                 │
│                                                                             │
│   ┌───────────┐       ┌───────────┐        ┌───────────────────┐           │
│   │ workspaces│       │   epoch   │        │Creates Workspace  │           │
│   │  - abc123 │       │     2     │        │ Doc internally    │           │
│   │  - xyz789 │       │           │        │ definition + data │           │
│   └─────┬─────┘       └─────┬─────┘        └─────────┬─────────┘           │
│         │                   │                        │                      │
│         ▼                   ▼                        ▼                      │
│                                                                             │
│      GUID            +   EPOCH         =      WORKSPACE DOC ID              │
│    "abc123"               2                   "abc123-2"                    │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────  │
│                                                                             │
│   Fetch GUID          Fetch version         Create WorkspaceClient          │
│   from Registry       from Head Doc         (Workspace Doc is internal)     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**The pattern:** Two exported helpers (Registry, Head) + internal Workspace Doc creation via `createClient()`.

| Step | Document  | Fetches                | Y.Doc GUID              | API                   |
| ---- | --------- | ---------------------- | ----------------------- | --------------------- |
| 1    | Registry  | GUID (workspace ID)    | `{registryId}`          | `createRegistryDoc()` |
| 2    | Head      | Epoch (version number) | `{workspaceId}`         | `createHeadDoc()`     |
| 3    | Workspace | Data only              | `{workspaceId}-{epoch}` | `createClient()`      |

## Why Three Documents?

A single Y.Doc per workspace seems simpler, but creates problems:

1. **Different sync scopes**: Registry syncs only to YOUR devices; workspace data syncs to ALL collaborators
2. **Epoch migrations**: Bumping epochs requires a stable pointer (Head) separate from content (Workspace Doc)
3. **Discovery**: Users need to know which workspaces they have access to before loading them

## Document Types

```
┌─────────────────────────────────────────────────────────────────┐
│  REGISTRY Y.Doc                                                  │
│  ID: {registryId}                                                │
│  Scope: Personal (syncs across user's own devices only)          │
│                                                                  │
│  Y.Map('workspaces')                                             │
│    └── {workspaceId}: true                                       │
│                                                                  │
│  Purpose: "Which workspaces do I have access to?"                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ User picks a workspace
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  HEAD Y.Doc                                                      │
│  ID: {workspaceId}                                               │
│  Scope: Shared (syncs with all workspace collaborators)          │
│                                                                  │
│  Y.Map('epochs')                                                 │
│    └── {clientId}: number   // Per-client epoch proposals        │
│                                                                  │
│  getEpoch() → max(all epoch values)                              │
│                                                                  │
│  Purpose: "What's the current epoch for this workspace?"         │
│                                                                  │
│  Note: Workspace metadata (name, icon, description) is stored    │
│  in static definition.json files, NOT in Y.Doc.                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Read epoch, compute Workspace Doc ID
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  WORKSPACE Y.Doc (created internally by createClient())          │
│  ID: {workspaceId}-{epoch}                                       │
│  Scope: Shared (syncs with all workspace collaborators)          │
│                                                                  │
│  Y.Array('table:{tableName}')  <- One array per table            │
│    └── { key: rowId, val: { field: value, ... }, ts: number }    │
│                                                                  │
│  Y.Array('kv')  <- KV settings as LWW entries                    │
│    └── { key: keyName, val: value, ts: number }                  │
│                                                                  │
│  Purpose: "Data only for this epoch (no definition)"             │
│                                                                  │
│  Note: Schema definitions are stored in static JSON files,       │
│  NOT in Y.Doc. This keeps Y.Docs lean and focused on data.       │
│  Both tables and KV use YKeyValueLww for last-write-wins CRDT.   │
└─────────────────────────────────────────────────────────────────┘
```

## CRDT-Safe Epoch Pattern

The Head Doc uses a **per-client MAX pattern** to handle concurrent epoch bumps safely.

### The Problem with Naive Counters

A simple `epoch: number` field is broken for CRDTs:

```typescript
// BAD: Two clients bump simultaneously
// Client A reads epoch=2, sets epoch=3
// Client B reads epoch=2, sets epoch=3
// Result: epoch=3, but one bump was lost!
headMap.set('epoch', epoch + 1);
```

In YJS, concurrent writes to the same key don't merge; the higher `clientID` wins.

### The Solution: Per-Client Keys with MAX

Each client writes their proposed epoch to their own key (their `clientID`).
The current epoch is computed as `max()` of all proposals:

```
Y.Map('epochs')
  └── "1090160253": 3   // Client A proposed epoch 3
  └── "2847291038": 3   // Client B also proposed epoch 3
  └── "9182736450": 5   // Client C proposed epoch 5

getEpoch() → max(3, 3, 5) → 5
```

### Why MAX Instead of SUM?

This is similar to the [learn.yjs.dev counter pattern](https://learn.yjs.dev/lessons/02-counter/),
but uses `max()` instead of `sum()`:

| Pattern | Aggregation | Use Case                  | Concurrent Bumps |
| ------- | ----------- | ------------------------- | ---------------- |
| Counter | `sum()`     | "How many clicks total?"  | A:1 + B:1 = 2    |
| Epoch   | `max()`     | "What version are we on?" | max(1, 1) = 1    |

With **SUM**, two concurrent bumps would skip an epoch (0 → 2).
With **MAX**, two concurrent bumps converge to the same next version (0 → 1).

### API

```typescript
const head = createHeadDoc({ workspaceId: 'abc123' });

// Get current epoch (max of all client proposals)
head.getEpoch(); // 0

// Get THIS client's own epoch (may differ from getEpoch())
head.getOwnEpoch(); // 0

// Bump epoch safely (handles concurrent bumps)
head.bumpEpoch(); // Returns 1

// Set own epoch (for UI epoch selector, rollbacks)
// Clamped to global epoch - can't set higher than getEpoch()
head.setOwnEpoch(2); // Returns actual epoch set

// Subscribe to epoch changes
head.observeEpoch((newEpoch) => {
	// Recreate client at new epoch
});

// Debug: see all client proposals
head.getEpochProposals(); // Map { "1090160253" => 1 }
```

## Boot Flow

```typescript
// ═══════════════════════════════════════════════════════════════
// STEP 1: Registry Doc - Get GUID
// ═══════════════════════════════════════════════════════════════
const registryId = authServer.getRegistryId(userId);
const registry = createRegistryDoc({ registryId });
await syncProvider.connect(registry.ydoc); // Sync with user's devices

const workspaceIds = registry.getWorkspaceIds();
// → ['abc123', 'xyz789']

// User selects a workspace
const workspaceId = 'abc123';

// ═══════════════════════════════════════════════════════════════
// STEP 2: Head Doc - Get Epoch
// ═══════════════════════════════════════════════════════════════
const head = createHeadDoc({ workspaceId });
await syncProvider.connect(head.ydoc); // Sync with collaborators

const epoch = head.getEpoch();
// → 2

// Optional: Subscribe to epoch changes for live migrations
head.observeEpoch((newEpoch) => {
	// Reconnect to new Workspace Doc when epoch bumps
});

// ═══════════════════════════════════════════════════════════════
// STEP 3: Create Client (Workspace Doc created internally)
// ═══════════════════════════════════════════════════════════════
const definition = defineWorkspace({
	id: workspaceId, // GUID only (epoch passed to createClient())
	slug: 'blog',
	name: 'Blog',
	tables: { posts: { id: id(), title: text() } },
	kv: {},
});

const client = createClient(definition.id, { epoch })
	.withDefinition(definition)
	.withExtensions({ sqlite, persistence });

// Now you have a fully typed client
await client.whenSynced;
client.tables.posts.upsert({ id: '1', title: 'Hello' });
```

## Why Separate Head from Workspace Doc?

Workspace Docs are **immutable by ID**:

- `abc123-0` is epoch 0's data
- `abc123-1` is epoch 1's data
- `abc123-2` is epoch 2's data

They're different Y.Docs with different GUIDs. You can't "upgrade" a Y.Doc in place; you create a new one.

The Head Doc is the **stable pointer**. Its GUID never changes (`abc123`), but its `epoch` value can change. When you bump epochs:

1. Create new client at epoch 3: `createClient(definition.id, { epoch: 3 }).withDefinition(definition).withExtensions({})`
2. Migrate data from old client to new client
3. Bump Head Doc: `head.bumpEpoch()`
4. All clients observing Head reconnect to the new Workspace Doc

## Epoch System

Epochs enable atomic migrations and compaction:

```
Epoch 0: Initial data
    │
    │ Definition migration needed
    ▼
Epoch 1: Migrated data (new definition)
    │
    │ Compaction needed (Y.Doc too large)
    ▼
Epoch 2: Compacted data (fresh Y.Doc)
```

**To bump epochs:**

1. Create new client at `epoch + 1`
2. Migrate/transform data from old client to new client
3. Call `head.bumpEpoch()` (safe for concurrent bumps)
4. All clients observing Head reconnect to new Workspace Doc

**Concurrent bump safety**: If two clients both call `bumpEpoch()` simultaneously,
they both propose the same "next" epoch. After sync, `getEpoch()` returns that
value; no epochs are skipped.

## Static Definition Architecture

Definitions are stored in static JSON files, NOT in Y.Doc. This is a deliberate design choice:

```typescript
// Definition is static (from code or definition.json file)
const definition = defineWorkspace({
	id: 'blog',
	tables: {
		posts: { id: id(), title: text(), published: boolean() },
	},
	kv: {},
});

// createClient() uses definition for type safety but doesn't store it in Y.Doc
const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({});
```

**Why static definitions?**

1. **Lean Y.Docs**: Y.Doc contains only data (rows, KV values), not schema
2. **Predictable migrations**: Schema changes happen through code, not CRDT sync
3. **Type safety**: Definition comes from TypeScript, enabling compile-time checking
4. **Validation**: Use `validateWorkspaceDefinition()` when loading from JSON files

For runtime validation of definitions loaded from external sources:

```typescript
import { validateWorkspaceDefinition } from '@epicenter/hq/dynamic';

const json = await Bun.file('definition.json').json();
const result = validateWorkspaceDefinition(json);
if (result.ok) {
	const definition = result.data;
	// Use definition...
} else {
	console.error('Invalid definition:', result.errors);
}
```

## Simplified Flow (Prototyping)

If you don't need multi-user sync or epoch migrations, skip Registry and Head:

```typescript
const definition = defineWorkspace({
  id: 'my-workspace',
  slug: 'blog',
  name: 'Blog',
  tables: { ... },
  kv: {}
});

// Epoch defaults to 0
const client = createClient(definition.id)
	.withDefinition(definition)
	.withExtensions({ sqlite });
```

## Files

| File                | Factory           | Purpose                   |
| ------------------- | ----------------- | ------------------------- |
| `head-doc.ts`       | `createHeadDoc()` | Epoch pointer (CRDT-safe) |
| `workspace-doc.ts`  | (types only)      | Y.Map type aliases        |
| `provider-types.ts` | (types only)      | Provider factory types    |

**Note:** Workspace Doc creation is handled internally by `createClient()` in the `workspace/` module.

## Storage Key Constants

Y.Doc array keys are defined in `shared/ydoc-keys.ts` and exported from the root entry point:

```typescript
import { KV_KEY, TableKey } from '@epicenter/hq';

// KV_KEY is the literal 'kv'
const kvArray = ydoc.getArray(KV_KEY);

// TableKey() creates 'table:{name}' with generic passthrough
const postsArray = ydoc.getArray(TableKey('posts'));
// Type: Y.Array<...> with key 'table:posts' (literal type preserved)
```

Use these constants when building custom providers or accessing the raw Y.Doc.

## Data Storage Format

Y.Doc contains only data, stored using YKeyValueLww (Last-Write-Wins) pattern:

```typescript
// Table row stored as LWW entry in Y.Array('table:posts')
{
  key: 'row-abc123',           // Row ID
  val: {                       // Row data
    id: 'row-abc123',
    title: 'Hello World',
    published: true
  },
  ts: 1706200000000            // Timestamp for LWW resolution
}

// KV setting stored as LWW entry in Y.Array('kv')
{
  key: 'theme',                // Setting key
  val: 'dark',                 // Setting value
  ts: 1706200000000            // Timestamp for LWW resolution
}
```

**Why YKeyValueLww?**

1. Predictable conflict resolution: "last write wins" based on timestamp
2. Self-healing clock skew: devices adopt highest timestamp seen from peers
3. Efficient storage: one entry per key after compaction
4. Simple mental model: same pattern for tables and KV

## Usage

```typescript
import {
	createHeadDoc,
	defineWorkspace,
	id,
	text,
} from '@epicenter/hq/dynamic';

// Head (epoch pointer)
const head = createHeadDoc({ workspaceId: 'workspace456', providers: {} });
const epoch = head.getEpoch(); // 0

// Bump epoch (CRDT-safe)
const newEpoch = head.bumpEpoch(); // 1

// Define and create workspace (Workspace Doc created internally)
const definition = defineWorkspace({
	id: 'workspace456',
	tables: { posts: { id: id(), title: text() } },
	kv: {},
});

const client = createClient(definition.id, { epoch })
	.withDefinition(definition)
	.withExtensions({});
// client.ydoc is the Workspace Doc at guid "workspace456-0"
```

## References

- [learn.yjs.dev Counter Lesson](https://learn.yjs.dev/lessons/02-counter/) - The per-client key pattern
- [.claude/skills/yjs/SKILL.md](../../../../.claude/skills/yjs/SKILL.md) - Single-Writer Keys pattern documentation
