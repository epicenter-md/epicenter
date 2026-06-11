# Handoff: Collaborative Workspace Config Y.Doc

> **Status: Superseded**: This spec was a design document. The API evolved during implementation. The current API uses `createWorkspace(definition)` instead of `workspace.create()`. See `packages/epicenter/src/static/README.md` for the current API.

**Date**: 2026-01-08 (Updated)
**Parent Spec**: `20260108T133200-collaborative-workspace-config-ydoc.md`

## Implementation Status

### Phase 5: Remove StoredFieldDefinition ✅ COMPLETE

Simplified by eliminating the intermediate type entirely:

| Before                                                                      | After                     | Rationale                   |
| --------------------------------------------------------------------------- | ------------------------- | --------------------------- |
| `FieldDefinition` → `prepareForStorage()` → `StoredFieldDefinition` → Y.Doc | `FieldDefinition` → Y.Doc | No conversion needed        |
| `StoredFieldDefinition` type definition                                     | Removed                   | Redundant intermediate type |
| `prepareForStorage()` function                                              | Removed                   | Was just a type cast        |

**Key insight**: Since TypeBox schemas ARE JSON Schema, `FieldDefinition` is directly serializable. No intermediate type or conversion function is needed.

### Phase 4: TypeBox for JSON Fields ✅ COMPLETE

Replaced arktype/zod `StandardSchema` with TypeBox `TSchema`:

| Before                                                          | After                                                     | Rationale               |
| --------------------------------------------------------------- | --------------------------------------------------------- | ----------------------- |
| `json({ schema: type({ foo: 'string' }) })`                     | `json({ schema: Type.Object({ foo: Type.String() }) })`   | TypeBox IS JSON Schema  |
| `StandardSchema` → `standardSchemaToJsonSchema()` → JSON Schema | `TSchema` (already JSON Schema)                           | No conversion needed    |
| Runtime validation via StandardSchema                           | Runtime validation via `Compile()` from `typebox/compile` | JIT-compiled validation |

**API Change:**

```typescript
// Before (arktype)
import { type } from 'arktype';
json({ schema: type({ theme: 'string', darkMode: 'boolean' }) });

// After (TypeBox)
import { Type } from 'typebox';
json({
	schema: Type.Object({ theme: Type.String(), darkMode: Type.Boolean() }),
});
```

### Phase 3: Unified FieldDefinition Storage ✅ COMPLETE

`FieldDefinition` now stores full metadata for Notion-like collaborative editing:

| Before                                          | After                             | Rationale                                            |
| ----------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| `SerializedFieldDefinition` (stripped metadata) | `FieldDefinition` (full metadata) | Enables collaborative editing                        |
| `name`, `description`, `icon` stripped          | Preserved in Y.Doc                | Users can rename fields, add descriptions, set icons |

**Key insight**: The original design stripped metadata because "nobody uses it", but that was circular reasoning. For Notion-like collaborative schema editing, metadata must be stored in Y.Doc.

### Phase 1: Terminology Refactor ✅ COMPLETE

Workspace identifiers standardized:

| Old    | New    | Description                        |
| ------ | ------ | ---------------------------------- |
| `guid` | `id`   | 15-char globally unique identifier |
| `id`   | `slug` | Human-readable name for URLs/paths |

### Phase 2: 3-Document Architecture ✅ COMPLETE

Created factory functions for the three Y.Doc types:

| Factory                                 | Y.Doc ID                | Purpose                  |
| --------------------------------------- | ----------------------- | ------------------------ |
| `createRegistryDoc({ registryId })`     | `{registryId}`          | Personal workspace index |
| `createHeadDoc({ workspaceId })`        | `{workspaceId}`         | Epoch pointer            |
| `createDataDoc({ workspaceId, epoch })` | `{workspaceId}-{epoch}` | Schema + data            |

### Phase 3: Schema Storage & Seeding ✅ COMPLETE

`workspace.create()` now:

1. Creates DataDoc (wraps Y.Doc with schema storage)
2. Seeds schema from code definition on first run (if not already seeded)
3. Seeds workspace name to Y.Doc metadata

---

## What's Implemented

### Files Created

```
packages/epicenter/src/core/docs/
├── index.ts           # Re-exports
├── registry-doc.ts    # createRegistryDoc factory
├── head-doc.ts        # createHeadDoc factory
└── data-doc.ts        # createDataDoc factory with schema seeding
```

### Files Modified

```
packages/epicenter/src/core/workspace/contract.ts  # Uses DataDoc, seeds schema
packages/epicenter/src/index.ts                    # Exports new doc types
```

### Commits (on branch `feat/workspace-id-slug-terminology`)

```
748371a refactor(schema): remove StoredFieldDefinition, use FieldDefinition directly
62db83c refactor(schema): use TypeBox for json field schemas
1e4228e refactor(schema): unify FieldDefinition storage in Y.Doc for collaborative editing
2f7df8c feat(epicenter): integrate DataDoc with schema seeding into workspace
d36d4cd feat(epicenter): add collaborative Y.Doc wrappers for 3-document architecture
e756241 docs(spec): add collaborative workspace config spec and handoff
059d791 refactor: update apps and examples for workspace id→slug rename
1915d73 refactor(epicenter): update CLI and server for new workspace terminology
de01600 feat(workspace): rename workspace guid→id, id→slug in core types
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CODE DEFINITION                                    │
│  defineWorkspace({ id, slug, name, tables, kv })                            │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           workspace.create()                                 │
│                                                                              │
│  1. createDataDoc({ workspaceId: id, epoch: 0 })                            │
│  2. dataDoc.mergeSchema(tables, kv)  ← Idempotent merge, CRDT handles       │
│  3. dataDoc.setName(name)            ← Only if not already set              │
│  4. createTables(dataDoc.ydoc, tables)                                       │
│  5. createKv(dataDoc.ydoc, kv)                                               │
│  6. Run capability factories                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Future: Full 3-Document Architecture

```
                                    AUTH SERVER
                                        │
                            ┌───────────┴───────────┐
                            │  registryId           │
                            │  bootstrapSyncNodes   │
                            │  permissions          │
                            └───────────┬───────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
              DEVICE A              DEVICE B            DEVICE C
                    │                   │                   │
        ┌───────────┴───────────┐       │                   │
        │                       │       │                   │
   REGISTRY Y.Doc          REGISTRY Y.Doc              REGISTRY Y.Doc
   {registryId}            {registryId}                {registryId}
   (personal, syncs        (syncs across               (syncs across
    across A's devices)     B's devices)               C's devices)
        │                       │                           │
        └───────────────────────┼───────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │   HEAD Y.Doc          │
                    │   {workspaceId}       │  ← Shared among
                    │   epoch: 0            │     all collaborators
                    └───────────┬───────────┘
                                │
                    ┌───────────┴───────────┐
                    │   DATA Y.Doc          │
                    │   {workspaceId}-0     │  ← Shared among
                    │   schema + data       │     all collaborators
                    └───────────────────────┘
```

---

## What Remains

### Integration Tasks (Not Yet Implemented)

| Task                          | Status     | Description                                        |
| ----------------------------- | ---------- | -------------------------------------------------- |
| **Registry integration**      | ⏳ Pending | Connect RegistryDoc to auth server's `registryId`  |
| **Head → Data flow**          | ⏳ Pending | Read epoch from HeadDoc before creating DataDoc    |
| **Epoch bump**                | ⏳ Pending | Implement `bumpEpoch()` for schema migrations      |
| **Permission checks**         | ⏳ Pending | Sync server validates access before room join      |
| **Runtime schema validation** | ⏳ Pending | Use Y.Doc schema instead of code schema at runtime |

### Current Simplifications

1. **Epoch hardcoded to 0**: The HeadDoc exists but workspace.create() doesn't read from it yet
2. **No Registry lookup**: Workspaces are still file-based discovery, not Registry Y.Doc
3. **Code schema = runtime schema**: Both compile-time and runtime use the code-defined schema

### Next Steps (Priority Order)

1. **Connect HeadDoc to workspace flow**
   - Create HeadDoc in `workspace.create()`
   - Read `epoch` from HeadDoc to determine DataDoc ID
   - Subscribe to epoch changes

2. **Implement epoch bump**
   - Add `bumpEpoch()` to HeadDoc or DataDoc
   - Migrate data from old epoch to new epoch
   - Notify connected clients

3. **Connect RegistryDoc to auth**
   - Get `registryId` from auth server on login
   - Use RegistryDoc for workspace discovery
   - Replace file-based workspace discovery

4. **Add permission layer**
   - Check permissions before sync room join
   - Implement share links for invitations

---

## API Reference

### createRegistryDoc

```typescript
const registry = createRegistryDoc({ registryId: 'xyz789012345abc' });

registry.addWorkspace('workspace-id');
registry.removeWorkspace('workspace-id');
registry.hasWorkspace('workspace-id');     // boolean
registry.getWorkspaceIds();                // string[]
registry.count();                          // number
registry.observe(({ added, removed }) => { ... });
registry.destroy();
```

### createHeadDoc

```typescript
const head = createHeadDoc({ workspaceId: 'abc123xyz789012' });

head.getEpoch();           // number (currently 0)
head.getDataDocId();       // 'abc123xyz789012-0'
head.bumpEpoch();          // atomically sets epoch = max(current, current+1), returns new epoch
head.observeEpoch((epoch) => { ... });
head.destroy();
```

**Note**: The Head Doc is minimal. Just stores `epoch: number`. No `isMigrating` flag needed; epoch bump is an atomic pointer flip. Old epochs remain accessible for historical viewing.

### createDataDoc

```typescript
const data = createDataDoc({ workspaceId: 'abc123xyz789012', epoch: 0 });

// Metadata
data.getName();
data.setName('My Workspace');

// Schema (merge semantics - idempotent, call on every create)
data.hasSchema();                      // boolean
data.mergeSchema(tables, kv);          // Merge code schema into Y.Doc (preserves metadata)
data.getTableSchema('posts');          // Map<fieldName, FieldDefinition>
data.getTableNames();                  // string[]
data.getKvSchema('theme');             // FieldDefinition
data.getKvNames();                     // string[]
data.addTableField('posts', 'newField', text());
data.removeTableField('posts', 'oldField');
data.observeSchemaChanges(({ tablesAdded, tablesRemoved, fieldsChanged }) => { ... });

// Raw Y.Map access
data.getTablesMap();   // Y.Map for table data
data.getKvMap();       // Y.Map for kv data
data.getSchemaMap();   // Y.Map for schema

data.destroy();
```

---

## References

- Parent spec: `20260108T133200-collaborative-workspace-config-ydoc.md`
- Local-first discovery: `20260108T062000-local-first-workspace-discovery.md`
- Workspace GUID epochs: `20260107T005800-workspace-guid-and-epochs.md`
