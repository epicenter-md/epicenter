# Document Architecture v2

**Status**: Design In Progress
**Created**: 2026-01-21
**Updated**: 2026-01-21
**Purpose**: Define the three-doc architecture for local, relay, and cloud modes
**Related**:

- [specs/20260121T170000-sync-architecture.md](./20260121T170000-sync-architecture.md)
- [specs/20260121T222800-registry-and-sync-ux.md](./20260121T222800-registry-and-sync-ux.md)

---

## Executive Summary

Epicenter uses a **three-document architecture** where each document type has a specific scope and sync behavior:

| Document          | Scope         | Contains                     | Syncs Via         |
| ----------------- | ------------- | ---------------------------- | ----------------- |
| **Registry Doc**  | Per user      | Workspace list + preferences | Local/Relay only  |
| **Head Doc**      | Per workspace | Identity + epoch             | Local/Relay/Cloud |
| **Workspace Doc** | Per epoch     | Schema + data                | Local/Relay/Cloud |

### Key Changes from v1

1. **Name/icon moved to Head Doc**: Workspace identity is now separate from per-epoch schema
2. **Cloud uses NanoID doc IDs**: Simpler, globally unique without encoding org
3. **Registry is local-only in cloud mode**: Cloud workspaces come from server API
4. **Schema stays per-epoch**: Epochs exist for schema migrations

---

## Document Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         THREE-DOC HIERARCHY                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  REGISTRY DOC                                                                │
│  "Which workspaces do I have?"                                              │
│  ────────────────────────────────────────────────────────────────────────   │
│  Scope: Per user                                                             │
│  Syncs: Local/Relay only (NOT in cloud mode)                                │
│                                                                              │
│       │                                                                      │
│       │ lists                                                                │
│       ▼                                                                      │
│                                                                              │
│  HEAD DOC (one per workspace)                                               │
│  "What is this workspace? What epoch?"                                      │
│  ────────────────────────────────────────────────────────────────────────   │
│  Scope: Per workspace (shared with collaborators)                           │
│  Syncs: Local/Relay/Cloud                                                   │
│                                                                              │
│       │                                                                      │
│       │ points to                                                            │
│       ▼                                                                      │
│                                                                              │
│  WORKSPACE DOC (one per epoch)                                              │
│  "What's the schema? What's the data?"                                      │
│  ────────────────────────────────────────────────────────────────────────   │
│  Scope: Per epoch (shared with collaborators)                               │
│  Syncs: Local/Relay/Cloud                                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Document Structures

### Registry Doc

**Purpose**: Track which workspaces the user has access to, plus UI preferences.

**Scope**: Per user. In local/relay mode, syncs across user's devices. In cloud mode, not used (server API provides workspace list).

```typescript
// Registry Doc Structure
Y.Doc {
  guid: 'local:registry'  // or 'registry' for simplicity

  Y.Map('workspaces')
  └── workspaceId: true   // Set of workspace IDs

  Y.Map('preferences')
  └── workspaceId: {
        pinned: boolean,
        order: number,
        hidden: boolean,
      }
}
```

**Example:**

```
Y.Map('workspaces')
├── "epicenter.whispering": true
└── "my-notes": true

Y.Map('preferences')
├── "epicenter.whispering": { pinned: true, order: 0, hidden: false }
└── "my-notes": { pinned: false, order: 1, hidden: false }
```

---

### Head Doc

**Purpose**: Store workspace identity (name, icon) and current epoch pointer.

**Scope**: Per workspace. Shared with all collaborators. Changes apply to all epochs.

```typescript
// Head Doc Structure
Y.Doc {
  guid: '{workspaceId}'           // Local/Relay: "epicenter.whispering"
     // or '{nanoId}'              // Cloud: "abc123xyz789qwe"

  Y.Map('meta')
  ├── name: string                // "Whispering"
  ├── icon: IconDefinition | null // { type: 'emoji', value: '🎙️' }
  └── description: string         // "Voice recordings and transcriptions"

  Y.Map('epochs')
  └── clientId: number            // Per-client epoch proposals (CRDT pattern)
}
```

**Example:**

```
Y.Map('meta')
├── name: "Whispering"
├── icon: { type: "emoji", value: "🎙️" }
└── description: "Voice recordings and transcriptions"

Y.Map('epochs')
├── "1090160253": 2
├── "2847291038": 2
└── "9182736450": 2

getEpoch() → max(2, 2, 2) → 2
```

**Why name/icon are in Head Doc:**

- Renaming applies to all epochs immediately
- No duplication across epochs
- Can list workspaces without loading every Workspace Doc

---

### Workspace Doc

**Purpose**: Store schema and data for a specific epoch.

**Scope**: Per epoch. Shared with all collaborators. Frozen when epoch bumps.

```typescript
// Workspace Doc Structure
Y.Doc {
  guid: '{workspaceId}-{epoch}'   // Local/Relay: "epicenter.whispering-0"
     // or '{nanoId}-{epoch}'      // Cloud: "abc123xyz789qwe-0"

  Y.Map('schema')
  ├── tables: {
  │     [tableName]: {
  │       name: string,
  │       description: string,
  │       fields: { [fieldName]: FieldSchema }
  │     }
  │   }
  └── kv: {
        [keyName]: {
          name: string,
          description: string,
          field: FieldSchema
        }
      }

  Y.Map('tables')
  └── [tableName]: Y.Map<rowId, Y.Map<fieldName, value>>

  Y.Map('kv')
  └── [keyName]: value
}
```

**Example:**

```
Y.Map('schema')
└── tables:
    └── recordings:
        ├── name: "Recordings"
        ├── description: "Voice recordings"
        └── fields:
            ├── id: { type: "id" }
            ├── title: { type: "text" }
            ├── audio: { type: "text" }  // file path
            └── createdAt: { type: "date" }

Y.Map('tables')
└── recordings:
    ├── "rec_001": { id: "rec_001", title: "Meeting notes", ... }
    └── "rec_002": { id: "rec_002", title: "Voice memo", ... }

Y.Map('kv')
├── theme: "dark"
└── language: "en"
```

**Why schema is per-epoch:**

- Epochs exist for schema migrations
- Breaking schema changes require new epoch
- Old epochs are frozen with their original schema
- Can view historical data as it was structured

---

## Doc ID Conventions

### Local/Relay Mode (Human-Readable)

| Document  | ID Pattern              | Example                  |
| --------- | ----------------------- | ------------------------ |
| Registry  | `registry`              | `registry`               |
| Head      | `{workspaceId}`         | `epicenter.whispering`   |
| Workspace | `{workspaceId}-{epoch}` | `epicenter.whispering-0` |

### Cloud Mode (NanoID)

| Document  | ID Pattern         | Example                |
| --------- | ------------------ | ---------------------- |
| Registry  | N/A (not used)     | N/A                    |
| Head      | `{nanoId}`         | `abc123xyz789qwerty`   |
| Workspace | `{nanoId}-{epoch}` | `abc123xyz789qwerty-0` |

**Why NanoID for cloud:**

- Globally unique without encoding org
- Simpler (no colons or special characters)
- Server maps human-readable ID to NanoID
- 21 characters = ~149 years of unique IDs at 1000/second

---

## Data Flows

### Local/Relay Mode

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         LOCAL/RELAY MODE DATA FLOW                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STEP 1: Load Registry Doc                                                   │
│  ─────────────────────────                                                   │
│  Source: Local storage (+ relay sync if connected)                          │
│  Doc ID: "registry"                                                          │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Registry Doc                                                        │    │
│  │  └── workspaces: ["epicenter.whispering", "my-notes"]               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  → Output: ['epicenter.whispering', 'my-notes']                             │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STEP 2: Load Head Doc (per workspace)                                       │
│  ─────────────────────────────────────                                       │
│  Source: Local storage (+ relay sync if connected)                          │
│  Doc ID: "{workspaceId}"                                                    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Head Doc (epicenter.whispering)                                     │    │
│  │  ├── meta: { name: "Whispering", icon: {...} }                      │    │
│  │  └── epochs: { clientId: 0 }                                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  → Output: { name: "Whispering", epoch: 0 }                                 │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STEP 3: Load Workspace Doc                                                  │
│  ─────────────────────────────                                               │
│  Source: Local storage (+ relay sync if connected)                          │
│  Doc ID: "{workspaceId}-{epoch}"                                            │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Workspace Doc (epicenter.whispering-0)                              │    │
│  │  ├── schema: { tables: {...}, kv: {...} }                           │    │
│  │  ├── tables: { recordings: {...} }                                  │    │
│  │  └── kv: { theme: "dark" }                                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  → Output: Ready to use workspace client                                    │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  SYNC BEHAVIOR                                                               │
│  ─────────────                                                               │
│  All three docs sync via Y-Sweet to self-hosted relay (if connected)       │
│                                                                              │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐                            │
│  │ Device A │ ←──→│  Relay   │←──→ │ Device B │                            │
│  │          │     │ (Y-Sweet)│     │          │                            │
│  └──────────┘     └──────────┘     └──────────┘                            │
│                                                                              │
│  Registry, Head, and Workspace docs all sync                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Cloud Mode

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLOUD MODE DATA FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STEP 1: Fetch Workspace List from Server                                    │
│  ────────────────────────────────────────                                    │
│  Source: Server API (authenticated)                                         │
│  Endpoint: GET /api/orgs/{orgId}/workspaces                                 │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Server Response                                                     │    │
│  │  {                                                                   │    │
│  │    workspaces: [                                                     │    │
│  │      {                                                               │    │
│  │        workspaceId: "epicenter.whispering",  // Human-readable      │    │
│  │        docId: "abc123xyz789qwerty",          // NanoID for Y-Sweet  │    │
│  │        name: "Whispering",                   // Cached from Head    │    │
│  │        icon: { type: "emoji", value: "🎙️" } // Cached from Head    │    │
│  │      }                                                               │    │
│  │    ]                                                                 │    │
│  │  }                                                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  → Output: Workspace list with doc IDs                                      │
│                                                                              │
│  NOTE: No Registry Doc in cloud mode! Server is the source of truth.        │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STEP 2: Load Head Doc via Y-Sweet                                          │
│  ─────────────────────────────────                                           │
│  Source: Y-Sweet (Epicenter Cloud)                                          │
│  Doc ID: "{nanoId}" (from server response)                                  │
│                                                                              │
│  2a. Request Y-Sweet token from server                                      │
│      POST /api/y-sweet/token { docId: "abc123xyz789qwerty" }               │
│                                                                              │
│  2b. Connect to Y-Sweet with token                                          │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Head Doc (abc123xyz789qwerty)                                       │    │
│  │  ├── meta: { name: "Whispering", icon: {...} }                      │    │
│  │  └── epochs: { clientId: 0 }                                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  → Output: { name: "Whispering", epoch: 0 }                                 │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STEP 3: Load Workspace Doc via Y-Sweet                                     │
│  ──────────────────────────────────────                                      │
│  Source: Y-Sweet (Epicenter Cloud)                                          │
│  Doc ID: "{nanoId}-{epoch}"                                                 │
│                                                                              │
│  3a. Request Y-Sweet token from server                                      │
│      POST /api/y-sweet/token { docId: "abc123xyz789qwerty-0" }             │
│                                                                              │
│  3b. Connect to Y-Sweet with token                                          │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Workspace Doc (abc123xyz789qwerty-0)                                │    │
│  │  ├── schema: { tables: {...}, kv: {...} }                           │    │
│  │  ├── tables: { recordings: {...} }                                  │    │
│  │  └── kv: { theme: "dark" }                                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  → Output: Ready to use workspace client                                    │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  SYNC BEHAVIOR                                                               │
│  ─────────────                                                               │
│  Head and Workspace docs sync via Y-Sweet (Epicenter Cloud)                 │
│                                                                              │
│  ┌──────────┐     ┌──────────────────┐     ┌──────────┐                    │
│  │ Device A │ ←──→│  Epicenter Cloud │←──→ │ Device B │                    │
│  │          │     │  (Y-Sweet + S3)  │     │          │                    │
│  └──────────┘     └──────────────────┘     └──────────┘                    │
│                                                                              │
│  Registry is NOT synced; workspace list comes from server API              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Side-by-Side Comparison

| Aspect                    | Local/Relay Mode         | Cloud Mode             |
| ------------------------- | ------------------------ | ---------------------- |
| **Workspace list source** | Local Registry Doc       | Server API             |
| **Registry Doc syncs?**   | Yes (via relay)          | No (not used)          |
| **Head Doc syncs?**       | Yes (via relay)          | Yes (via Y-Sweet)      |
| **Workspace Doc syncs?**  | Yes (via relay)          | Yes (via Y-Sweet)      |
| **Doc ID format**         | Human-readable           | NanoID                 |
| **Head Doc ID**           | `epicenter.whispering`   | `abc123xyz789qwerty`   |
| **Workspace Doc ID**      | `epicenter.whispering-0` | `abc123xyz789qwerty-0` |
| **Auth required?**        | No                       | Yes (Better Auth)      |
| **Multi-org support?**    | No                       | Yes                    |

---

## Server Database Schema (Cloud Mode)

```sql
-- Workspace registry: maps human-readable IDs to NanoIDs
CREATE TABLE workspace_registry (
  doc_id TEXT PRIMARY KEY,              -- NanoID: "abc123xyz789qwerty"
  workspace_id TEXT NOT NULL,           -- Human-readable: "epicenter.whispering"
  organization_id TEXT NOT NULL,        -- Org: "org_alice_personal"

  -- Cached from Head Doc (denormalized for fast listing)
  name TEXT,                            -- "Whispering"
  icon JSONB,                           -- { type: "emoji", value: "🎙️" }
  description TEXT,                     -- "Voice recordings"

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(organization_id, workspace_id) -- One workspace ID per org
);

-- Index for listing workspaces by org
CREATE INDEX idx_workspace_registry_org ON workspace_registry(organization_id);
```

**Note**: `name`, `icon`, `description` are cached copies of what's in the Head Doc. They're denormalized for fast workspace listing without loading every Head Doc.

When a Head Doc changes, the server should update the cache (via Y-Sweet webhook or periodic sync).

---

## Static vs Dynamic Workspaces

### Static Workspaces

Defined in code (e.g., Whispering):

```typescript
// apps/whispering/src/lib/workspace.ts
export const whisperingWorkspace = defineWorkspace({
	id: 'epicenter.whispering',
	tables: {
		recordings: { id: id(), title: text(), audio: text() },
	},
	kv: {},
});
```

**Characteristics:**

- Schema comes from code
- Always available (app knows about it)
- In local mode: auto-created on first run
- In cloud mode: created when user first uses the app

### Dynamic Workspaces

Created by users at runtime:

```typescript
// User clicks "Create Workspace" in UI
const newWorkspace = await createDynamicWorkspace({
	name: 'My Notes',
	tables: { notes: { id: id(), content: text() } },
});
```

**Characteristics:**

- Schema defined by user (or from template)
- Must be registered to be discovered
- In local mode: added to Registry Doc
- In cloud mode: added to server DB

---

## Epoch Mechanics

### What Triggers an Epoch Bump?

| Trigger             | Epoch Bump Needed? | Why?                |
| ------------------- | ------------------ | ------------------- |
| Add optional column | No                 | Backward compatible |
| Add required column | Yes                | Breaking change     |
| Remove column       | Yes                | Data loss           |
| Rename column       | Yes                | Schema mismatch     |
| Compact Y.Doc       | Yes                | Fresh document      |
| Corruption recovery | Yes                | Start fresh         |

### Epoch Bump Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EPOCH BUMP FLOW                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Create new Workspace Doc at epoch N+1                                   │
│     Doc ID: "epicenter.whispering-1"                                        │
│                                                                              │
│  2. Migrate data from epoch N to epoch N+1                                  │
│     (Apply schema transformations)                                          │
│                                                                              │
│  3. Bump epoch in Head Doc                                                  │
│     head.bumpEpoch() → writes to Y.Map('epochs')                           │
│                                                                              │
│  4. All clients observe epoch change                                        │
│     head.observeEpoch((newEpoch) => reconnect())                           │
│                                                                              │
│  5. Clients reconnect to new Workspace Doc                                  │
│                                                                              │
│  Result:                                                                     │
│  - Old epoch (N) is frozen, read-only                                       │
│  - New epoch (N+1) is active                                                │
│  - All clients converge to new epoch                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Concurrent Epoch Bumps (CRDT Safety)

The Head Doc uses a per-client MAX pattern:

```typescript
Y.Map('epochs')
├── "client_a": 2  // Client A proposed epoch 2
├── "client_b": 2  // Client B also proposed epoch 2
└── "client_c": 1  // Client C still on epoch 1

getEpoch() → max(2, 2, 1) → 2
```

If two clients bump simultaneously:

- Both write their proposed epoch
- After sync, both see the same MAX
- No epochs skipped, no conflicts

---

## Migration Path from v1

### Changes Required

1. **Move `name`, `icon`, `description` from Workspace Doc to Head Doc**
   - Update `createHeadDoc()` to include `Y.Map('meta')`
   - Update `createClient()` to read name from Head Doc, not Workspace Doc
   - Migration: copy values from latest Workspace Doc to Head Doc

2. **Rename `definition` to `schema` in Workspace Doc**
   - Update `Y.Map('definition')` to `Y.Map('schema')`
   - Remove `name`, `icon`, `description` from schema
   - Keep `tables` and `kv` definitions

3. **Add `preferences` map to Registry Doc**
   - Update `createRegistryDoc()` to include `Y.Map('preferences')`

4. **Update cloud API to return `docId` (NanoID)**
   - Generate NanoID when workspace is created
   - Return both `workspaceId` and `docId` in API responses

### Backward Compatibility

For existing local workspaces:

1. On load, check if Head Doc has `meta` map
2. If not, migrate from Workspace Doc's `definition`
3. Write to Head Doc (one-time migration)

---

## Design Decisions (Resolved)

### Q: Should `description` be Y.Text or plain string?

**Decision: Plain string.**

Y.Text is for character-level collaborative editing (real-time cursors, concurrent typing). Workspace descriptions are short metadata, not collaborative documents. Last-write-wins semantics are actually better here. If two users edit the description simultaneously, you want one coherent result, not a merged mess. The overhead of Y.Text isn't justified.

Same logic applies to `name`: it's short metadata, not a document.

### Q: What should the container map be named?

**Decision: `meta`.**

| Name       | Problem                                           |
| ---------- | ------------------------------------------------- |
| `identity` | Too specific. Doesn't cover all metadata           |
| `info`     | Too generic                                       |
| `header`   | Implies a UI concept                              |
| `metadata` | Verbose                                           |
| **`meta`** | **Concise, universally understood, clear intent** |

### Q: Why Y.Map('meta') vs top-level fields?

**Decision: Use Y.Map('meta').**

1. **Namespace isolation**: `meta.name` can't conflict with a future top-level `name` field
2. **Atomic observation**: `meta.observeDeep()` catches all identity changes
3. **Cleaner API**: `headDoc.getMeta()` vs tracking three separate getters
4. **Extensibility**: Easy to add `createdAt`, `color`, `coverImage` later

---

## Open Questions

### Q1: Should server cache name/icon from Head Doc?

**Proposed**: Yes, denormalize into `workspace_registry` table for fast listing.

**Alternative**: Always fetch from Head Doc (slower but no sync issues).

### Q2: How does server know when Head Doc changes?

**Options:**

- Y-Sweet webhook (if supported)
- Periodic polling
- Client notifies server after changes

### Q3: What happens if cached name differs from Head Doc?

**Proposed**: Head Doc is authoritative. Cache is eventually consistent. Client always reads from Head Doc for display.

---

## Implementation Progress

- [x] Update `packages/epicenter/src/core/docs/head-doc.ts` to include `Y.Map('meta')`
  - Added `WorkspaceMeta` type with name, icon, description
  - Added `getMeta()`, `setMeta()`, `observeMeta()`, `hasMeta()` methods
- [x] Rename `definition` to `schema` in Workspace Doc
  - Changed `WORKSPACE_DOC_MAPS.DEFINITION` → `WORKSPACE_DOC_MAPS.SCHEMA`
  - Renamed `mergeDefinitionIntoYDoc` → `mergeSchemaIntoYDoc`
  - Renamed `readDefinitionFromYDoc` → `readSchemaFromYDoc`
  - Renamed `WorkspaceDefinitionMap` → `WorkspaceSchemaMap`
  - Renamed `DefinitionMap` → `SchemaMap`
  - Added deprecated aliases for backward compatibility
- [x] Remove `name`, `icon` from Workspace schema (they live in Head Doc now)
  - `WorkspaceSchemaMap` no longer includes `name` or `icon`
  - Legacy `readDefinitionFromYDoc` still reads them for migration
- [x] Update `createClient()` to use new schema functions
  - Uses `mergeSchemaIntoYDoc` instead of `mergeDefinitionIntoYDoc`
  - Uses `readSchemaFromYDoc` internally
  - `getDefinition()` still returns legacy format for backward compatibility
- [x] Update exports and types in index.ts
  - Exports new types: `WorkspaceMeta`, `WorkspaceSchemaMap`, `SchemaMap`
  - Exports new functions: `mergeSchemaIntoYDoc`, `readSchemaFromYDoc`
  - Maintains deprecated exports for backward compatibility
- [x] Run typecheck - no new type errors introduced
- [x] Update README docs to reflect new architecture
  - Updated `apps/epicenter/src/lib/docs/README.md` with:
    - Head Doc now shows `Y.Map('meta')` + `Y.Map('epochs')`
    - Workspace Doc shows `Y.Map('schema')` instead of `Y.Map('definition')`
    - `definition.json` → `schema.json` in storage layout
    - Updated helper function examples

### Migration Notes

The `readDefinitionFromYDoc` function still reads `name` and `icon` from the Workspace Doc
for migration purposes. New code should:

1. Use `HeadDoc.getMeta()` to read workspace identity
2. Use `HeadDoc.setMeta()` to set workspace identity
3. Use `readSchemaFromYDoc()` to read only the table/kv schema

### Future Work (Not in This PR)

- [ ] Update `packages/epicenter/src/core/docs/registry-doc.ts` to include `Y.Map('preferences')`
- [ ] Design cloud API endpoints
- [ ] Implement NanoID generation for cloud doc IDs
- [ ] Add actual migration code in apps to copy name/icon from Workspace Doc to Head Doc
