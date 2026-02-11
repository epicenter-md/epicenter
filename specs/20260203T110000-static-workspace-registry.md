# Static Workspace Registry and Viewing

**Status**: Implementing
**Created**: 2026-02-03
**Depends on**: 20260203T100000-static-workspace-viewing.md

---

## Executive Summary

This specification details the storage, discovery, and UI integration for static workspaces in the Epicenter Tauri app. Static workspaces sync via Y-Sweet and are viewed without TypeScript runtime—only their IDs are needed.

**Key decisions:**
1. **Single registry file**: `static-workspaces.json` in app data directory (not per-workspace folders)
2. **Minimal metadata**: ID, optional name/icon, optional sync URL override
3. **Lazy Y.Doc initialization**: Create and connect only when viewing a workspace
4. **Sidebar integration**: "Static Workspaces" section in HomeSidebar

---

## Storage Architecture

### File Location

```
{appLocalDataDir}/
├── workspaces/                    # Dynamic workspaces (existing)
│   └── {id}/
│       ├── definition.json
│       ├── workspace.yjs
│       └── kv.json
└── static-workspaces.json         # NEW: Static workspace registry
```

**Why separate from `workspaces/` folder?**
- Dynamic workspaces have complex per-workspace storage (definition, Y.Doc binary, KV mirror)
- Static workspaces only need IDs—no local schema or persistence
- Clear conceptual separation: "workspaces I own" vs "workspaces I observe"

### Registry Schema

```typescript
// apps/epicenter/src/lib/static-workspaces/types.ts

/**
 * A registered static workspace for viewing
 */
export type StaticWorkspaceEntry = {
  /** Unique workspace identifier (used as Y.Doc guid) */
  id: string;
  /** Display name (defaults to id if not provided) */
  name?: string;
  /** Icon in tagged format: 'emoji:📊' or 'lucide:layout-grid' */
  icon?: string;
  /** Override sync server URL (uses app default if not set) */
  syncUrl?: string;
  /** When this entry was added */
  addedAt: string; // ISO 8601
};

/**
 * The static workspaces registry file format
 */
export type StaticWorkspacesRegistry = {
  /** Schema version for future migrations */
  version: 1;
  /** List of registered static workspaces */
  workspaces: StaticWorkspaceEntry[];
};
```

### Example File

```json
{
  "version": 1,
  "workspaces": [
    {
      "id": "tab-manager",
      "name": "Tab Manager",
      "icon": "lucide:layout-grid",
      "addedAt": "2026-02-03T10:00:00.000Z"
    },
    {
      "id": "whispering",
      "name": "Whispering",
      "icon": "emoji:🎤",
      "syncUrl": "ws://192.168.1.100:8080",
      "addedAt": "2026-02-03T11:00:00.000Z"
    },
    {
      "id": "custom-workspace-abc123",
      "addedAt": "2026-02-03T12:00:00.000Z"
    }
  ]
}
```

---

## Service Layer

### File: `apps/epicenter/src/lib/services/static-workspaces.ts`

```typescript
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { StaticWorkspaceEntry, StaticWorkspacesRegistry } from '$lib/static-workspaces/types';

const REGISTRY_FILE = 'static-workspaces.json';

async function getRegistryPath(): Promise<string> {
  const baseDir = await appLocalDataDir();
  return join(baseDir, REGISTRY_FILE);
}

function createEmptyRegistry(): StaticWorkspacesRegistry {
  return { version: 1, workspaces: [] };
}

/**
 * Load the static workspaces registry
 */
export async function loadStaticWorkspacesRegistry(): Promise<StaticWorkspacesRegistry> {
  const path = await getRegistryPath();
  try {
    const content = await readTextFile(path);
    return JSON.parse(content) as StaticWorkspacesRegistry;
  } catch {
    // File doesn't exist yet, return empty registry
    return createEmptyRegistry();
  }
}

/**
 * Save the static workspaces registry
 */
async function saveRegistry(registry: StaticWorkspacesRegistry): Promise<void> {
  const path = await getRegistryPath();
  await writeTextFile(path, JSON.stringify(registry, null, '\t'));
}

/**
 * List all registered static workspaces
 */
export async function listStaticWorkspaces(): Promise<StaticWorkspaceEntry[]> {
  const registry = await loadStaticWorkspacesRegistry();
  return registry.workspaces;
}

/**
 * Get a single static workspace by ID
 */
export async function getStaticWorkspace(id: string): Promise<StaticWorkspaceEntry | null> {
  const registry = await loadStaticWorkspacesRegistry();
  return registry.workspaces.find(w => w.id === id) ?? null;
}

/**
 * Add a new static workspace to the registry
 */
export async function addStaticWorkspace(
  entry: Omit<StaticWorkspaceEntry, 'addedAt'>
): Promise<StaticWorkspaceEntry> {
  const registry = await loadStaticWorkspacesRegistry();

  // Check for duplicate
  if (registry.workspaces.some(w => w.id === entry.id)) {
    throw new Error(`Static workspace "${entry.id}" already exists`);
  }

  const newEntry: StaticWorkspaceEntry = {
    ...entry,
    addedAt: new Date().toISOString(),
  };

  registry.workspaces.push(newEntry);
  await saveRegistry(registry);

  return newEntry;
}

/**
 * Update an existing static workspace entry
 */
export async function updateStaticWorkspace(
  id: string,
  updates: Partial<Omit<StaticWorkspaceEntry, 'id' | 'addedAt'>>
): Promise<StaticWorkspaceEntry | null> {
  const registry = await loadStaticWorkspacesRegistry();
  const index = registry.workspaces.findIndex(w => w.id === id);

  if (index === -1) return null;

  registry.workspaces[index] = {
    ...registry.workspaces[index],
    ...updates,
  };

  await saveRegistry(registry);
  return registry.workspaces[index];
}

/**
 * Remove a static workspace from the registry
 */
export async function removeStaticWorkspace(id: string): Promise<boolean> {
  const registry = await loadStaticWorkspacesRegistry();
  const index = registry.workspaces.findIndex(w => w.id === id);

  if (index === -1) return false;

  registry.workspaces.splice(index, 1);
  await saveRegistry(registry);

  return true;
}
```

---

## Query Layer

### File: `apps/epicenter/src/lib/query/static-workspaces.ts`

```typescript
import { Ok, Err } from 'wellcrafted/result';
import { createTaggedError } from 'wellcrafted/error';
import { queryClient, defineQuery, defineMutation } from './client';
import {
  listStaticWorkspaces,
  getStaticWorkspace,
  addStaticWorkspace,
  updateStaticWorkspace,
  removeStaticWorkspace,
} from '$lib/services/static-workspaces';
import type { StaticWorkspaceEntry } from '$lib/static-workspaces/types';

// Error factory
const StaticWorkspaceErr = createTaggedError('StaticWorkspaceError');

// Query keys
const staticWorkspaceKeys = {
  all: ['static-workspaces'] as const,
  list: () => [...staticWorkspaceKeys.all, 'list'] as const,
  detail: (id: string) => [...staticWorkspaceKeys.all, 'detail', id] as const,
};

export const staticWorkspaces = {
  // Queries
  listStaticWorkspaces: defineQuery({
    queryKey: staticWorkspaceKeys.list(),
    queryFn: async () => {
      const entries = await listStaticWorkspaces();
      return Ok(entries);
    },
  }),

  getStaticWorkspace: (id: string) =>
    defineQuery({
      queryKey: staticWorkspaceKeys.detail(id),
      queryFn: async () => {
        const entry = await getStaticWorkspace(id);
        if (!entry) {
          return StaticWorkspaceErr({ message: `Static workspace "${id}" not found` });
        }
        return Ok(entry);
      },
    }),

  // Mutations
  addStaticWorkspace: defineMutation({
    mutationKey: ['static-workspaces', 'add'],
    mutationFn: async (input: Omit<StaticWorkspaceEntry, 'addedAt'>) => {
      try {
        const entry = await addStaticWorkspace(input);
        queryClient.invalidateQueries({ queryKey: staticWorkspaceKeys.list() });
        return Ok(entry);
      } catch (error) {
        return StaticWorkspaceErr({ message: String(error) });
      }
    },
  }),

  updateStaticWorkspace: defineMutation({
    mutationKey: ['static-workspaces', 'update'],
    mutationFn: async (input: {
      id: string;
      updates: Partial<Omit<StaticWorkspaceEntry, 'id' | 'addedAt'>>;
    }) => {
      const entry = await updateStaticWorkspace(input.id, input.updates);
      if (!entry) {
        return StaticWorkspaceErr({ message: `Static workspace "${input.id}" not found` });
      }
      queryClient.invalidateQueries({ queryKey: staticWorkspaceKeys.list() });
      queryClient.invalidateQueries({ queryKey: staticWorkspaceKeys.detail(input.id) });
      return Ok(entry);
    },
  }),

  removeStaticWorkspace: defineMutation({
    mutationKey: ['static-workspaces', 'remove'],
    mutationFn: async (id: string) => {
      const removed = await removeStaticWorkspace(id);
      if (!removed) {
        return StaticWorkspaceErr({ message: `Static workspace "${id}" not found` });
      }
      queryClient.invalidateQueries({ queryKey: staticWorkspaceKeys.list() });
      return Ok(undefined);
    },
  }),
};
```

### Update RPC Export

```typescript
// apps/epicenter/src/lib/query/index.ts
import { workspaces } from './workspaces';
import { staticWorkspaces } from './static-workspaces';

export const rpc = {
  workspaces,
  staticWorkspaces,
};
```

---

## Y.Doc Discovery Utilities

### File: `apps/epicenter/src/lib/docs/discover.ts`

```typescript
import * as Y from 'yjs';

/**
 * LWW entry structure used by YKeyValueLww
 */
export type YKeyValueLwwEntry<T = unknown> = {
  key: string;
  val: T;
  ts: number;
};

/**
 * Discover all table names from a Y.Doc by scanning ydoc.share
 * Tables are stored as Y.Arrays with keys like 'table:{name}'
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
 * KV is stored as a single Y.Array at key 'kv'
 */
export function discoverKvKeys(ydoc: Y.Doc): string[] {
  const kvArray = ydoc.getArray<YKeyValueLwwEntry>('kv');
  const keys = new Set<string>();

  for (const entry of kvArray.toArray()) {
    if (entry && typeof entry === 'object' && 'key' in entry) {
      keys.add(entry.key);
    }
  }

  return [...keys].sort();
}

/**
 * Read all rows from a table (untyped)
 * Returns deduplicated rows using LWW semantics
 */
export function readTableRows(ydoc: Y.Doc, tableName: string): Record<string, unknown>[] {
  const array = ydoc.getArray<YKeyValueLwwEntry>(`table:${tableName}`);
  const entries = array.toArray();

  // Group by row ID (entries use cell-level keys: "rowId:fieldId")
  const rowMap = new Map<string, { data: Record<string, unknown>; maxTs: number }>();

  for (const entry of entries) {
    if (!entry?.key || entry.val === undefined) continue;

    // Parse cell key: "rowId:fieldId"
    const colonIndex = entry.key.indexOf(':');
    if (colonIndex === -1) continue;

    const rowId = entry.key.slice(0, colonIndex);
    const fieldId = entry.key.slice(colonIndex + 1);

    let row = rowMap.get(rowId);
    if (!row) {
      row = { data: { id: rowId }, maxTs: 0 };
      rowMap.set(rowId, row);
    }

    // LWW: only keep if newer timestamp
    row.data[fieldId] = entry.val;
    row.maxTs = Math.max(row.maxTs, entry.ts);
  }

  return [...rowMap.values()]
    .sort((a, b) => b.maxTs - a.maxTs) // Most recently updated first
    .map(r => r.data);
}

/**
 * Read a KV value by key (untyped)
 * Uses LWW semantics to find the latest value
 */
export function readKvValue(ydoc: Y.Doc, key: string): unknown | undefined {
  const kvArray = ydoc.getArray<YKeyValueLwwEntry>('kv');

  let latest: YKeyValueLwwEntry | undefined;

  for (const entry of kvArray.toArray()) {
    if (entry?.key === key) {
      if (!latest || entry.ts > latest.ts) {
        latest = entry;
      }
    }
  }

  return latest?.val;
}

/**
 * Read all KV values (untyped)
 */
export function readAllKv(ydoc: Y.Doc): Record<string, unknown> {
  const kvArray = ydoc.getArray<YKeyValueLwwEntry>('kv');
  const result: Record<string, { val: unknown; ts: number }> = {};

  for (const entry of kvArray.toArray()) {
    if (!entry?.key) continue;

    const existing = result[entry.key];
    if (!existing || entry.ts > existing.ts) {
      result[entry.key] = { val: entry.val, ts: entry.ts };
    }
  }

  return Object.fromEntries(
    Object.entries(result).map(([k, v]) => [k, v.val])
  );
}

/**
 * Get summary statistics for a Y.Doc
 */
export function getYDocSummary(ydoc: Y.Doc): {
  tables: { name: string; rowCount: number }[];
  kvKeys: string[];
  totalEntries: number;
} {
  const tables = discoverTables(ydoc).map(name => ({
    name,
    rowCount: readTableRows(ydoc, name).length,
  }));

  const kvKeys = discoverKvKeys(ydoc);

  const totalEntries = tables.reduce((sum, t) => sum + t.rowCount, 0) + kvKeys.length;

  return { tables, kvKeys, totalEntries };
}
```

---

## Y-Sweet Connection Utilities

### File: `apps/epicenter/src/lib/docs/y-sweet-connection.ts`

```typescript
import * as Y from 'yjs';
import { createYjsProvider, type YSweetProvider } from '@y-sweet/client';

export type YSweetConnectionConfig = {
  /** Workspace ID (used as Y.Doc guid and room name) */
  workspaceId: string;
  /** Y-Sweet server base URL (e.g., 'http://127.0.0.1:8080') */
  serverUrl: string;
};

export type YSweetConnection = {
  ydoc: Y.Doc;
  provider: YSweetProvider;
  whenSynced: Promise<void>;
  destroy: () => void;
};

/**
 * Create a Y.Doc connected to a Y-Sweet server
 * Uses direct mode (no authentication)
 */
export function createYSweetConnection(config: YSweetConnectionConfig): YSweetConnection {
  const { workspaceId, serverUrl } = config;

  // Create Y.Doc with workspace ID as guid
  const ydoc = new Y.Doc({ guid: workspaceId });

  // Create provider with direct connection info
  const provider = createYjsProvider(ydoc, workspaceId, async () => ({
    url: `${serverUrl.replace('http', 'ws')}/d/${workspaceId}/ws`,
    baseUrl: serverUrl,
    docId: workspaceId,
    token: undefined, // No auth in direct mode
  }));

  // Create sync promise
  const whenSynced = new Promise<void>((resolve) => {
    if (provider.synced) {
      resolve();
    } else {
      const handleSync = (synced: boolean) => {
        if (synced) {
          provider.off('sync', handleSync);
          resolve();
        }
      };
      provider.on('sync', handleSync);
    }
  });

  const destroy = () => {
    provider.destroy();
    ydoc.destroy();
  };

  return { ydoc, provider, whenSynced, destroy };
}

/**
 * Get the default Y-Sweet server URL from app settings
 * Falls back to localhost:8080 if not configured
 */
export function getDefaultSyncUrl(): string {
  // TODO: Read from app settings store
  return 'http://127.0.0.1:8080';
}
```

---

## Route Structure

### File: `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+layout.ts`

```typescript
import { error } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';
import { getStaticWorkspace } from '$lib/services/static-workspaces';
import { createYSweetConnection, getDefaultSyncUrl } from '$lib/docs/y-sweet-connection';
import { discoverTables, discoverKvKeys } from '$lib/docs/discover';

export const load: LayoutLoad = async ({ params }) => {
  const workspaceId = params.id;
  console.log(`[StaticLayout] Loading static workspace: ${workspaceId}`);

  // Get registry entry (may not exist for ad-hoc viewing)
  const entry = await getStaticWorkspace(workspaceId);

  // Determine sync URL
  const syncUrl = entry?.syncUrl ?? getDefaultSyncUrl();

  // Create Y-Sweet connection
  const connection = createYSweetConnection({
    workspaceId,
    serverUrl: syncUrl,
  });

  // Wait for initial sync
  try {
    await Promise.race([
      connection.whenSynced,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Sync timeout')), 10000)
      ),
    ]);
  } catch (e) {
    console.error(`[StaticLayout] Failed to sync: ${e}`);
    // Don't throw - allow viewing even if sync fails
  }

  // Discover structure
  const tables = discoverTables(connection.ydoc);
  const kvKeys = discoverKvKeys(connection.ydoc);

  console.log(`[StaticLayout] Discovered ${tables.length} tables, ${kvKeys.length} KV keys`);

  return {
    workspaceId,
    entry, // May be null for ad-hoc viewing
    connection,
    tables,
    kvKeys,
    displayName: entry?.name ?? workspaceId,
  };
};
```

### File: `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+layout.svelte`

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Sidebar } from '@epicenter/ui/sidebar';
  import StaticWorkspaceSidebar from '$lib/components/StaticWorkspaceSidebar.svelte';

  let { data, children } = $props();

  onDestroy(() => {
    console.log(`[StaticLayout] Destroying connection for ${data.workspaceId}`);
    data.connection.destroy();
  });
</script>

<Sidebar.Provider>
  <StaticWorkspaceSidebar
    workspaceId={data.workspaceId}
    displayName={data.displayName}
    tables={data.tables}
    kvKeys={data.kvKeys}
  />
  <Sidebar.Inset>
    <header class="flex h-12 items-center gap-2 border-b px-4">
      <Sidebar.Trigger />
      <span class="text-sm font-medium">{data.displayName}</span>
      <span class="text-xs text-muted-foreground">(static)</span>
    </header>
    <main class="flex-1 overflow-auto p-4">
      {@render children?.()}
    </main>
  </Sidebar.Inset>
</Sidebar.Provider>
```

### File: `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+page.svelte`

```svelte
<script lang="ts">
  import { Empty } from '@epicenter/ui/empty';
  import { Badge } from '@epicenter/ui/badge';
  import TableIcon from '@lucide/svelte/icons/table-2';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import DatabaseIcon from '@lucide/svelte/icons/database';
  import GenericTableViewer from '$lib/components/GenericTableViewer.svelte';
  import GenericKvViewer from '$lib/components/GenericKvViewer.svelte';

  let { data } = $props();
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center gap-3">
    <div class="flex size-10 items-center justify-center rounded-lg bg-muted">
      <DatabaseIcon class="size-5" />
    </div>
    <div>
      <h1 class="text-xl font-semibold">{data.displayName}</h1>
      <p class="font-mono text-sm text-muted-foreground">{data.workspaceId}</p>
    </div>
  </div>

  <!-- Summary -->
  <div class="flex gap-4">
    <Badge variant="secondary" class="gap-1.5">
      <TableIcon class="size-3" />
      {data.tables.length} tables
    </Badge>
    <Badge variant="secondary" class="gap-1.5">
      <SettingsIcon class="size-3" />
      {data.kvKeys.length} settings
    </Badge>
  </div>

  <!-- Content -->
  {#if data.tables.length === 0 && data.kvKeys.length === 0}
    <Empty.Root>
      <Empty.Header>
        <Empty.Media variant="icon">
          <DatabaseIcon />
        </Empty.Media>
        <Empty.Title>No data yet</Empty.Title>
        <Empty.Description>
          This workspace is empty or hasn't synced any data yet.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <!-- Tables -->
    {#if data.tables.length > 0}
      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">Tables</h2>
        {#each data.tables as tableName (tableName)}
          <GenericTableViewer
            ydoc={data.connection.ydoc}
            {tableName}
          />
        {/each}
      </section>
    {/if}

    <!-- KV -->
    {#if data.kvKeys.length > 0}
      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">Settings</h2>
        <GenericKvViewer
          ydoc={data.connection.ydoc}
          keys={data.kvKeys}
        />
      </section>
    {/if}
  {/if}
</div>
```

---

## UI Components

### File: `apps/epicenter/src/lib/components/GenericTableViewer.svelte`

```svelte
<script lang="ts">
  import * as Y from 'yjs';
  import { Card } from '@epicenter/ui/card';
  import { Badge } from '@epicenter/ui/badge';
  import TableIcon from '@lucide/svelte/icons/table-2';
  import { readTableRows } from '$lib/docs/discover';

  type Props = {
    ydoc: Y.Doc;
    tableName: string;
  };

  let { ydoc, tableName }: Props = $props();

  // Reactive rows with Y.Array observation
  let rows = $state<Record<string, unknown>[]>([]);

  $effect(() => {
    const array = ydoc.getArray(`table:${tableName}`);

    const updateRows = () => {
      rows = readTableRows(ydoc, tableName);
    };

    updateRows();
    array.observe(updateRows);

    return () => {
      array.unobserve(updateRows);
    };
  });

  // Derive columns from first row
  const columns = $derived(
    rows.length > 0 ? Object.keys(rows[0]).filter(k => k !== 'id') : []
  );
</script>

<Card.Root>
  <Card.Header class="pb-3">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <TableIcon class="size-4 text-muted-foreground" />
        <Card.Title class="text-base">{tableName}</Card.Title>
      </div>
      <Badge variant="secondary">{rows.length} rows</Badge>
    </div>
  </Card.Header>
  <Card.Content>
    {#if rows.length === 0}
      <p class="text-sm text-muted-foreground">No rows</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b">
              <th class="px-2 py-1.5 text-left font-medium text-muted-foreground">id</th>
              {#each columns as col}
                <th class="px-2 py-1.5 text-left font-medium text-muted-foreground">{col}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows.slice(0, 10) as row (row.id)}
              <tr class="border-b last:border-0">
                <td class="px-2 py-1.5 font-mono text-xs">{row.id}</td>
                {#each columns as col}
                  <td class="max-w-xs truncate px-2 py-1.5">
                    {#if typeof row[col] === 'object'}
                      <code class="text-xs">{JSON.stringify(row[col])}</code>
                    {:else}
                      {row[col]}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        {#if rows.length > 10}
          <p class="mt-2 text-xs text-muted-foreground">
            Showing 10 of {rows.length} rows
          </p>
        {/if}
      </div>
    {/if}
  </Card.Content>
</Card.Root>
```

### File: `apps/epicenter/src/lib/components/GenericKvViewer.svelte`

```svelte
<script lang="ts">
  import * as Y from 'yjs';
  import { Card } from '@epicenter/ui/card';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import { readKvValue } from '$lib/docs/discover';

  type Props = {
    ydoc: Y.Doc;
    keys: string[];
  };

  let { ydoc, keys }: Props = $props();

  // Reactive KV values
  let values = $state<Record<string, unknown>>({});

  $effect(() => {
    const kvArray = ydoc.getArray('kv');

    const updateValues = () => {
      const newValues: Record<string, unknown> = {};
      for (const key of keys) {
        newValues[key] = readKvValue(ydoc, key);
      }
      values = newValues;
    };

    updateValues();
    kvArray.observe(updateValues);

    return () => {
      kvArray.unobserve(updateValues);
    };
  });
</script>

<Card.Root>
  <Card.Header class="pb-3">
    <div class="flex items-center gap-2">
      <SettingsIcon class="size-4 text-muted-foreground" />
      <Card.Title class="text-base">Settings</Card.Title>
    </div>
  </Card.Header>
  <Card.Content>
    <dl class="space-y-2">
      {#each keys as key (key)}
        <div class="flex items-start justify-between gap-4 rounded-md bg-muted/50 px-3 py-2">
          <dt class="font-mono text-sm font-medium">{key}</dt>
          <dd class="text-right text-sm text-muted-foreground">
            {#if typeof values[key] === 'object'}
              <code class="text-xs">{JSON.stringify(values[key])}</code>
            {:else if values[key] === undefined}
              <span class="italic">undefined</span>
            {:else}
              {values[key]}
            {/if}
          </dd>
        </div>
      {/each}
    </dl>
  </Card.Content>
</Card.Root>
```

### File: `apps/epicenter/src/lib/components/StaticWorkspaceSidebar.svelte`

```svelte
<script lang="ts">
  import { Sidebar } from '@epicenter/ui/sidebar';
  import DatabaseIcon from '@lucide/svelte/icons/database';
  import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
  import TableIcon from '@lucide/svelte/icons/table-2';
  import SettingsIcon from '@lucide/svelte/icons/settings';

  type Props = {
    workspaceId: string;
    displayName: string;
    tables: string[];
    kvKeys: string[];
  };

  let { workspaceId, displayName, tables, kvKeys }: Props = $props();
</script>

<Sidebar.Root>
  <Sidebar.Header>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton size="lg">
          <div class="flex size-8 items-center justify-center rounded-md border bg-background">
            <DatabaseIcon class="size-4" />
          </div>
          <div class="flex flex-col gap-0.5 leading-none">
            <span class="font-semibold">{displayName}</span>
            <span class="text-xs text-muted-foreground">Static Workspace</span>
          </div>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Header>

  <Sidebar.Content>
    <Sidebar.Group>
      <Sidebar.Menu>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton>
            {#snippet child({ props })}
              <a href="/" {...props}>
                <LayoutGridIcon />
                <span>All Workspaces</span>
              </a>
            {/snippet}
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.Group>

    <Sidebar.Separator />

    <!-- Tables -->
    <Sidebar.Group>
      <Sidebar.GroupLabel>Tables ({tables.length})</Sidebar.GroupLabel>
      <Sidebar.Menu>
        {#each tables as tableName (tableName)}
          <Sidebar.MenuItem>
            <Sidebar.MenuButton>
              <TableIcon />
              <span>{tableName}</span>
            </Sidebar.MenuButton>
          </Sidebar.MenuItem>
        {:else}
          <Sidebar.MenuItem>
            <span class="text-sm text-muted-foreground">No tables</span>
          </Sidebar.MenuItem>
        {/each}
      </Sidebar.Menu>
    </Sidebar.Group>

    <!-- KV -->
    <Sidebar.Group>
      <Sidebar.GroupLabel>Settings ({kvKeys.length})</Sidebar.GroupLabel>
      <Sidebar.Menu>
        {#each kvKeys as key (key)}
          <Sidebar.MenuItem>
            <Sidebar.MenuButton>
              <SettingsIcon />
              <span>{key}</span>
            </Sidebar.MenuButton>
          </Sidebar.MenuItem>
        {:else}
          <Sidebar.MenuItem>
            <span class="text-sm text-muted-foreground">No settings</span>
          </Sidebar.MenuItem>
        {/each}
      </Sidebar.Menu>
    </Sidebar.Group>
  </Sidebar.Content>
</Sidebar.Root>
```

---

## HomeSidebar Integration

### Modify: `apps/epicenter/src/lib/components/HomeSidebar.svelte`

Add a "Static Workspaces" section after the existing workspaces section:

```svelte
<!-- Add import -->
<script lang="ts">
  // ... existing imports
  import DatabaseIcon from '@lucide/svelte/icons/database';
  import { rpc } from '$lib/query';

  // ... existing queries
  const staticWorkspaces = createQuery(() => rpc.staticWorkspaces.listStaticWorkspaces.options);
</script>

<!-- Add after existing Workspaces group, before Footer -->
<Sidebar.Separator />

<Sidebar.Group>
  <Sidebar.GroupLabel>
    Static Workspaces
    <Sidebar.GroupAction title="Add static workspace" onclick={() => addStaticWorkspaceDialog.open()}>
      <PlusIcon />
    </Sidebar.GroupAction>
  </Sidebar.GroupLabel>
  <Sidebar.GroupContent>
    <Sidebar.Menu>
      {#if staticWorkspaces.isPending}
        <Sidebar.MenuItem>
          <span class="text-muted-foreground">Loading...</span>
        </Sidebar.MenuItem>
      {:else if staticWorkspaces.data}
        {#each staticWorkspaces.data as workspace (workspace.id)}
          <Sidebar.MenuItem>
            <Sidebar.MenuButton>
              {#snippet child({ props })}
                <a href="/workspaces/static/{workspace.id}" {...props}>
                  <DatabaseIcon />
                  <span>{workspace.name ?? workspace.id}</span>
                </a>
              {/snippet}
            </Sidebar.MenuButton>
          </Sidebar.MenuItem>
        {:else}
          <Sidebar.MenuItem>
            <span class="text-muted-foreground">No static workspaces</span>
          </Sidebar.MenuItem>
        {/each}
      {/if}
    </Sidebar.Menu>
  </Sidebar.GroupContent>
</Sidebar.Group>
```

---

## Add Static Workspace Dialog

### File: `apps/epicenter/src/lib/components/AddStaticWorkspaceDialog.svelte`

```svelte
<script lang="ts" module>
  import { createDialogState } from '$lib/utils/dialog-state';

  type AddStaticWorkspaceDialogOptions = {
    onConfirm: (data: { id: string; name?: string }) => Promise<void>;
  };

  function createAddStaticWorkspaceDialogState() {
    return createDialogState<AddStaticWorkspaceDialogOptions>();
  }

  export const addStaticWorkspaceDialog = createAddStaticWorkspaceDialogState();
</script>

<script lang="ts">
  import * as Dialog from '@epicenter/ui/dialog';
  import { Input } from '@epicenter/ui/input';
  import { Label } from '@epicenter/ui/label';
  import { Button } from '@epicenter/ui/button';

  let id = $state('');
  let name = $state('');
  let isPending = $state(false);

  const canConfirm = $derived(id.trim().length > 0 && !isPending);

  async function handleConfirm() {
    if (!canConfirm) return;

    isPending = true;
    try {
      await addStaticWorkspaceDialog.options?.onConfirm({
        id: id.trim(),
        name: name.trim() || undefined,
      });
      addStaticWorkspaceDialog.close();
      id = '';
      name = '';
    } finally {
      isPending = false;
    }
  }

  function handleCancel() {
    addStaticWorkspaceDialog.close();
    id = '';
    name = '';
    isPending = false;
  }
</script>

<Dialog.Root bind:open={addStaticWorkspaceDialog.isOpen}>
  <Dialog.Content class="sm:max-w-md">
    <form
      onsubmit={(e) => {
        e.preventDefault();
        handleConfirm();
      }}
    >
      <Dialog.Header>
        <Dialog.Title>Add Static Workspace</Dialog.Title>
        <Dialog.Description>
          Enter the ID of a static workspace to view its synced data.
        </Dialog.Description>
      </Dialog.Header>

      <div class="grid gap-4 py-4">
        <div class="grid gap-2">
          <Label for="workspace-id">Workspace ID</Label>
          <Input
            id="workspace-id"
            bind:value={id}
            placeholder="e.g., tab-manager"
            disabled={isPending}
            class="font-mono"
          />
          <p class="text-xs text-muted-foreground">
            The unique identifier used by the workspace
          </p>
        </div>

        <div class="grid gap-2">
          <Label for="workspace-name">Display Name (optional)</Label>
          <Input
            id="workspace-name"
            bind:value={name}
            placeholder="e.g., Tab Manager"
            disabled={isPending}
          />
        </div>
      </div>

      <Dialog.Footer>
        <Button variant="outline" type="button" onclick={handleCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canConfirm}>
          {isPending ? 'Adding...' : 'Add Workspace'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
```

---

## File Summary

| Path | Purpose |
|------|---------|
| `apps/epicenter/src/lib/static-workspaces/types.ts` | TypeScript types for registry |
| `apps/epicenter/src/lib/services/static-workspaces.ts` | Service layer (file I/O) |
| `apps/epicenter/src/lib/query/static-workspaces.ts` | Query layer (TanStack Query) |
| `apps/epicenter/src/lib/query/index.ts` | Export `staticWorkspaces` in rpc |
| `apps/epicenter/src/lib/docs/discover.ts` | Y.Doc discovery utilities |
| `apps/epicenter/src/lib/docs/y-sweet-connection.ts` | Y-Sweet connection factory |
| `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+layout.ts` | Route loader |
| `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+layout.svelte` | Route layout |
| `apps/epicenter/src/routes/(workspace)/workspaces/static/[id]/+page.svelte` | Main viewer page |
| `apps/epicenter/src/lib/components/GenericTableViewer.svelte` | Table viewer component |
| `apps/epicenter/src/lib/components/GenericKvViewer.svelte` | KV viewer component |
| `apps/epicenter/src/lib/components/StaticWorkspaceSidebar.svelte` | Sidebar for static workspaces |
| `apps/epicenter/src/lib/components/AddStaticWorkspaceDialog.svelte` | Dialog to add workspace by ID |
| `apps/epicenter/src/lib/components/HomeSidebar.svelte` | MODIFY: Add static workspaces section |
| `apps/epicenter/src/routes/+layout.svelte` | MODIFY: Mount dialog |

---

## Implementation Order

1. **Types** (`types.ts`) — Foundation
2. **Service Layer** (`static-workspaces.ts` service) — File I/O
3. **Query Layer** (`static-workspaces.ts` query) — TanStack integration
4. **Discovery Utilities** (`discover.ts`) — Y.Doc introspection
5. **Connection Utilities** (`y-sweet-connection.ts`) — Y-Sweet provider
6. **Route Structure** (`+layout.ts`, `+layout.svelte`, `+page.svelte`) — SvelteKit routes
7. **Viewer Components** (`GenericTableViewer`, `GenericKvViewer`) — Data display
8. **Sidebar Components** (`StaticWorkspaceSidebar`) — Navigation
9. **Dialog** (`AddStaticWorkspaceDialog`) — Adding workspaces
10. **Integration** (modify `HomeSidebar`, root layout) — Wire everything together

---

## Testing

### Manual Testing Steps

1. Start Y-Sweet server: `npx y-sweet@latest serve ./y-sweet-data`
2. Create test data (optional, use existing tab-manager workspace)
3. Navigate to `/workspaces/static/tab-manager`
4. Verify tables and KV are discovered and displayed
5. Add a static workspace via dialog
6. Verify it appears in sidebar
7. Test real-time updates (modify data in another client)

### Edge Cases to Test

- Empty workspace (no tables, no KV)
- Workspace with only tables
- Workspace with only KV
- Large table (100+ rows)
- Complex nested data in cells
- Sync timeout (server unavailable)
- Invalid workspace ID format

---

## Dependencies

### Existing Utilities Used

| Utility | Location | Purpose |
|---------|----------|---------|
| `createDialogState` | `$lib/utils/dialog-state` | Singleton dialog state factory for modal management |
| `defineQuery`, `defineMutation` | `$lib/query/client` | TanStack Query wrapper factories |
| `createTaggedError` | `wellcrafted/error` | Error factory for typed errors |
| `Ok` | `wellcrafted/result` | Result type for success wrapping |

---

## Error Handling

### Service Layer Errors

| Operation | Error Condition | Behavior |
|-----------|-----------------|----------|
| `loadStaticWorkspacesRegistry` | File read fails | Returns empty registry `{ version: 1, workspaces: [] }` |
| `addStaticWorkspace` | Duplicate ID | Throws `Error('Static workspace "{id}" already exists')` |
| `updateStaticWorkspace` | ID not found | Returns `null` |
| `removeStaticWorkspace` | ID not found | Returns `false` |

### Query Layer Error Propagation

All query layer functions wrap service calls and return `Result` types:
- Success: `Ok(data)`
- Failure: `StaticWorkspaceErr({ message: string })`

Components should check `.isOk()` or pattern match on the result.

### Connection Errors

| Error | Handling |
|-------|----------|
| Y-Sweet server unreachable | 10s timeout, continue with empty Y.Doc (no throw) |
| Invalid workspace ID | Connection created but Y.Doc will be empty |
| Sync never completes | Timeout resolves, UI shows "No data yet" state |

---

## Data Model Assumptions

### LWW Entry Contract

All Y.Doc data uses Last-Write-Wins (LWW) entries:

```typescript
type YKeyValueLwwEntry<T = unknown> = {
  key: string;   // Identifier (row:field for tables, key name for KV)
  val: T;        // The value
  ts: number;    // Timestamp in milliseconds (higher wins)
};
```

### Table Storage Format

Tables use cell-level keys for fine-grained conflict resolution:
- Key format: `"{rowId}:{fieldId}"`
- Stored in Y.Array at key `table:{tableName}`
- `discoverTables()` reconstructs rows from cell entries

### KV Storage Format

Key-value pairs stored in single Y.Array at key `kv`:
- Key format: plain string key name
- `readKvValue()` finds highest-timestamp entry for a given key
