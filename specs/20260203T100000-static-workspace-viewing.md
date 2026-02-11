# Static Workspace Viewing in Epicenter App

**Status**: Draft
**Created**: 2026-02-03
**Purpose**: Enable viewing static workspaces in the Tauri app without TypeScript runtime

---

## Executive Summary

Static workspaces can be **viewed** in the Epicenter app with minimal requirements:

1. **Only the workspace ID is needed** — structure is discoverable from Y.Doc
2. **No TypeScript runtime required** — `ydoc.share` exposes all table names
3. **Sync via y-sweet** — connect to relay server at `localhost:8080` or port 3913

The key insight: **you don't need the schema to read data**. The Y.Doc contains everything.

---

## How It Works

### Discovery via `ydoc.share`

Y.Doc has a `share` property — a `Map<string, AbstractType>` of all top-level shared types:

```typescript
// Given a Y.Doc with workspace data
const ydoc = new Y.Doc({ guid: workspaceId });

// Discover all tables
const tables: string[] = [];
ydoc.share.forEach((type, key) => {
  if (key.startsWith('table:') && type instanceof Y.Array) {
    tables.push(key.slice(7)); // Remove 'table:' prefix
  }
});

// Discover all KV keys
const kvArray = ydoc.getArray<YKeyValueLwwEntry>('kv');
const kvKeys = [...new Set(kvArray.toArray().map(entry => entry.key))];

console.log({ tables, kvKeys });
// { tables: ['posts', 'users'], kvKeys: ['theme', 'settings'] }
```

### Storage Format (from `ydoc-keys.ts`)

| Key Pattern | Type | Contents |
|-------------|------|----------|
| `table:{name}` | `Y.Array` | LWW entries: `{ key: id, val: row, ts: timestamp }` |
| `kv` | `Y.Array` | LWW entries: `{ key: name, val: value, ts: timestamp }` |

### What You Get Without TypeScript Runtime

| Feature | Works? | Notes |
|---------|--------|-------|
| Read all rows | ✅ | Just iterate the Y.Array |
| Read all KV values | ✅ | Filter by key in 'kv' array |
| Observe changes | ✅ | `array.observe()` works |
| Write raw data | ✅ | No validation, but works |
| Schema validation | ❌ | Requires runtime |
| Migrations | ❌ | Requires runtime |
| Type inference | ❌ | Data is `unknown` |

---

## Sync Architecture

### Option A: Y-Sweet Direct Mode (Recommended for Dev)

Connect directly to a y-sweet server without authentication:

```typescript
import { createYjsProvider } from '@y-sweet/client';

const ydoc = new Y.Doc({ guid: workspaceId });

// Connect to local y-sweet server
const provider = createYjsProvider(ydoc, workspaceId, async () => ({
  url: `ws://127.0.0.1:8080/d/${workspaceId}/ws`,
  baseUrl: 'http://127.0.0.1:8080',
  docId: workspaceId,
  token: undefined,
}));

// Wait for initial sync
await new Promise<void>(resolve => {
  if (provider.status === 'connected') resolve();
  else provider.on('sync', () => resolve());
});

// Now ydoc.share is populated with remote data
```

**Start y-sweet locally:**
```bash
npx y-sweet@latest serve        # In-memory
npx y-sweet@latest serve ./data # Persisted to disk
```

### Option B: Custom WebSocket (Port 3913)

If using the existing Epicenter sync server:

```typescript
import { WebsocketProvider } from 'y-websocket';

const ydoc = new Y.Doc({ guid: workspaceId });
const provider = new WebsocketProvider(
  'ws://localhost:3913/sync',
  workspaceId,
  ydoc
);

await provider.synced;
```

---

## Implementation Plan

### Phase 1: Read-Only Static Workspace Viewer

**Goal**: View any static workspace by entering its ID.

**Changes:**

1. **New route**: `/workspaces/static/[id]`
   - Input: workspace ID only
   - Creates Y.Doc with that guid
   - Connects to y-sweet (direct mode)
   - Discovers structure from `ydoc.share`
   - Renders tables and KV in generic viewer

2. **Generic table viewer component**
   ```svelte
   <script lang="ts">
     import * as Y from 'yjs';

     export let ydoc: Y.Doc;
     export let tableName: string;

     const array = ydoc.getArray(`table:${tableName}`);

     // Reactive rows from Y.Array
     let rows: unknown[] = [];
     $: {
       rows = array.toArray().map(entry => entry.val);
     }

     array.observe(() => {
       rows = array.toArray().map(entry => entry.val);
     });
   </script>

   <table>
     <tbody>
       {#each rows as row}
         <tr>
           <td><pre>{JSON.stringify(row, null, 2)}</pre></td>
         </tr>
       {/each}
     </tbody>
   </table>
   ```

3. **Static workspace list** (optional)
   - Config file listing known static workspace IDs
   - Or scan y-sweet for all documents

### Phase 2: Bidirectional Sync

**Goal**: Bun process creates/modifies static workspace, Tauri app views it.

```
┌─────────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│   Bun Process       │          │   Y-Sweet       │          │   Tauri App     │
│                     │          │   Server        │          │                 │
│   Static workspace  │◄────────►│   (8080)        │◄────────►│   Generic       │
│   with migrations   │  sync    │                 │  sync    │   viewer        │
│   and validation    │          │   Persists to   │          │                 │
│                     │          │   ./data        │          │   No TypeScript │
└─────────────────────┘          └─────────────────┘          └─────────────────┘
```

**Bun side** (runs TypeScript):
```typescript
// packages/epicenter/examples/static-workspace-server.ts
import { createWorkspace } from 'epicenter/static';
import { ySweetSync } from 'epicenter/extensions';
import { type } from 'arktype';

const posts = defineTable(type({ id: 'string', title: 'string', views: 'number' }));

const workspace = createWorkspace({
  id: 'my-static-workspace',
  tables: { posts },
}).withExtensions({
  sync: ySweetSync({ mode: 'direct', serverUrl: 'http://localhost:8080' }),
});

await workspace.capabilities.sync.whenSynced;

// Now any changes sync to y-sweet
workspace.tables.posts.set({ id: '1', title: 'Hello', views: 0 });
```

**Tauri side** (no TypeScript runtime):
```typescript
// apps/epicenter/src/routes/workspaces/static/[id]/+page.ts
export async function load({ params }) {
  const ydoc = new Y.Doc({ guid: params.id });

  // Connect to same y-sweet server
  const provider = createYjsProvider(ydoc, params.id, async () => ({
    url: `ws://127.0.0.1:8080/d/${params.id}/ws`,
    baseUrl: 'http://127.0.0.1:8080',
    docId: params.id,
  }));

  await whenSynced(provider);

  // Discover structure
  const tables = discoverTables(ydoc);
  const kvKeys = discoverKvKeys(ydoc);

  return { ydoc, tables, kvKeys };
}
```

### Phase 3: Known Static Workspaces Registry

**Goal**: Pre-register static workspaces with metadata.

Create a registry file that lists known static workspaces:

```typescript
// apps/epicenter/src/lib/static-workspaces.ts

export const STATIC_WORKSPACES = [
  {
    id: 'tab-manager',
    name: 'Tab Manager',
    description: 'Browser tab sync workspace',
    icon: 'lucide:layout-grid',
  },
  {
    id: 'whispering',
    name: 'Whispering',
    description: 'Voice transcription workspace',
    icon: 'lucide:mic',
  },
] as const;
```

This gives the UI friendly names and icons without needing TypeScript runtime.

---

## File Changes

### New Files

| Path | Purpose |
|------|---------|
| `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+page.svelte` | Static workspace viewer page |
| `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+layout.ts` | Load Y.Doc and discover structure |
| `apps/epicenter/src/lib/static-workspaces.ts` | Registry of known static workspaces |
| `apps/epicenter/src/lib/components/GenericTableViewer.svelte` | Render any Y.Array as a table |
| `apps/epicenter/src/lib/components/GenericKvViewer.svelte` | Render KV entries |
| `apps/epicenter/src/lib/docs/discover.ts` | `discoverTables()`, `discoverKvKeys()` utilities |

### Modified Files

| Path | Change |
|------|--------|
| `apps/epicenter/src/routes/(home)/+page.svelte` | Add "Static Workspaces" section |
| `apps/epicenter/src/lib/components/WorkspaceSidebar.svelte` | Show static workspaces |

---

## Utility Functions

```typescript
// apps/epicenter/src/lib/docs/discover.ts

import * as Y from 'yjs';

/**
 * Discover all table names from a Y.Doc by scanning ydoc.share
 */
export function discoverTables(ydoc: Y.Doc): string[] {
  const tables: string[] = [];

  ydoc.share.forEach((type, key) => {
    if (key.startsWith('table:') && type instanceof Y.Array) {
      tables.push(key.slice(7)); // Remove 'table:' prefix
    }
  });

  return tables.sort();
}

/**
 * Discover all KV keys from a Y.Doc
 */
export function discoverKvKeys(ydoc: Y.Doc): string[] {
  const kvArray = ydoc.getArray('kv');
  const keys = new Set<string>();

  for (const entry of kvArray.toArray()) {
    if (entry && typeof entry === 'object' && 'key' in entry) {
      keys.add(entry.key as string);
    }
  }

  return [...keys].sort();
}

/**
 * Read all rows from a table (untyped)
 */
export function readTableRows(ydoc: Y.Doc, tableName: string): unknown[] {
  const array = ydoc.getArray(`table:${tableName}`);
  return array.toArray().map((entry: any) => entry.val);
}

/**
 * Read a KV value by key (untyped)
 */
export function readKvValue(ydoc: Y.Doc, key: string): unknown | undefined {
  const kvArray = ydoc.getArray('kv');

  // Find entry with highest timestamp (LWW)
  let latest: { val: unknown; ts: number } | undefined;

  for (const entry of kvArray.toArray()) {
    if (entry?.key === key) {
      if (!latest || entry.ts > latest.ts) {
        latest = entry;
      }
    }
  }

  return latest?.val;
}
```

---

## UI Mockup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Epicenter                                              [Settings] [Sync]   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐  ┌───────────────────────────────────────────────────┐│
│  │ WORKSPACES      │  │                                                   ││
│  │                 │  │  Static Workspace: tab-manager                    ││
│  │  My Workspace   │  │  ────────────────────────────────                 ││
│  │  Project Alpha  │  │                                                   ││
│  │                 │  │  Tables discovered: 3                             ││
│  │ ─────────────── │  │  KV keys discovered: 2                            ││
│  │ STATIC          │  │                                                   ││
│  │                 │  │  ┌─────────────────────────────────────────────┐  ││
│  │  tab-manager    │  │  │ Table: windows                              │  ││
│  │  whispering     │  │  │ ─────────────────────────────────────────── │  ││
│  │                 │  │  │ { "id": "win_1", "title": "Main", ... }     │  ││
│  │ ─────────────── │  │  │ { "id": "win_2", "title": "Dev", ... }      │  ││
│  │ [+ Add by ID]   │  │  └─────────────────────────────────────────────┘  ││
│  │                 │  │                                                   ││
│  │                 │  │  ┌─────────────────────────────────────────────┐  ││
│  │                 │  │  │ Table: tabs                                 │  ││
│  │                 │  │  │ ─────────────────────────────────────────── │  ││
│  │                 │  │  │ 127 rows                                    │  ││
│  │                 │  │  └─────────────────────────────────────────────┘  ││
│  │                 │  │                                                   ││
│  └─────────────────┘  └───────────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Connection Flow

```
User enters workspace ID: "tab-manager"
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│  1. Create Y.Doc with guid                               │
│     const ydoc = new Y.Doc({ guid: 'tab-manager' });     │
└──────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│  2. Connect to y-sweet                                   │
│     ws://127.0.0.1:8080/d/tab-manager/ws                 │
└──────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│  3. Wait for sync                                        │
│     provider.on('sync', () => ...)                       │
└──────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│  4. Discover structure                                   │
│     ydoc.share.forEach((type, key) => ...)              │
└──────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│  5. Render tables and KV                                 │
│     Generic viewer, no schema needed                     │
└──────────────────────────────────────────────────────────┘
```

---

## Configuration

### Y-Sweet Server URL

Store in app settings (already exists):

```typescript
// In settings store
syncServerUrl: 'http://127.0.0.1:8080'
```

### Local Development

```bash
# Terminal 1: Start y-sweet
npx y-sweet@latest serve ./y-sweet-data

# Terminal 2: Start Bun process with static workspace
bun run packages/epicenter/examples/static-workspace-server.ts

# Terminal 3: Start Tauri app
bun run --filter @epicenter/app dev
```

---

## Edge Cases

### Empty Y.Doc (No Data Yet)

If the static workspace hasn't synced any data:
- `ydoc.share` will be empty
- Show "No tables found" message
- Keep connection open for real-time updates

### Workspace ID Doesn't Exist

Y-Sweet will create a new empty document:
- This is fine for development
- For production, validate against registry first

### Offline Mode

If y-sweet server is unreachable:
- Show connection error
- Retry with exponential backoff
- Allow viewing cached data if using IndexedDB persistence

---

## Future Enhancements

1. **Schema inference**: Analyze row data to guess field types
2. **Edit mode**: Allow raw JSON editing with confirmation
3. **Diff view**: Show changes between syncs
4. **Export**: Download Y.Doc as JSON or binary
5. **Import**: Load Y.Doc from file

---

## Summary

| What | How |
|------|-----|
| Minimum to view | Workspace ID only |
| Structure discovery | `ydoc.share` Map |
| Table names | Keys starting with `table:` |
| KV keys | Entries in `'kv'` array |
| Sync | Y-Sweet direct mode |
| TypeScript runtime | Not needed |
| Migrations | Not supported (view only) |
