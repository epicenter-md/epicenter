# Archived: HeadDoc and Registry Patterns

**Status**: Archived for future reference
**Date**: 2026-02-01
**Related Spec**: `specs/20260201T120000-simple-definition-first-workspace.md`

This document preserves the HeadDoc and Registry patterns from the original three-document architecture. These patterns are valuable for implementing versioned workspaces with epoch-based time travel in the future.

> **Why archived?** The simple definition-first workspace API (`createWorkspace(definition)`) doesn't need HeadDoc or Registry for basic use cases. These patterns are preserved here for when we implement versioned workspaces with `versionControl: true`.

---

## Three-Document Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         USER'S DEVICE LANDSCAPE                              │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────┐
  │  REGISTRY DOC    │
  │  (Personal)      │
  │                  │
  │  Lists which     │
  │  workspaces user │
  │  has access to   │
  └────────┬─────────┘
           │
           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                        HEAD DOC                             │
  │                    guid: "workspace-123"                    │
  │                                                             │
  │   Y.Map('epochs'): Per-client epoch proposals               │
  │   Y.Map('meta'): Workspace identity (name, icon, desc)      │
  │                                                             │
  │   current epoch = MAX(all epoch values)                     │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 │ epoch points to →
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                      WORKSPACE DOC                          │
  │                 guid: "workspace-123-{epoch}"               │
  │                                                             │
  │   Y.Array('table:posts')  - Table data (LWW entries)        │
  │   Y.Array('kv')           - KV settings (LWW entries)       │
  └─────────────────────────────────────────────────────────────┘
```

**Why three docs?**
- **Registry**: Personal — syncs only between YOUR devices (which workspaces do I have?)
- **Head**: Shared — lightweight pointer to current epoch (version control)
- **Workspace**: Shared — the actual data, tied to an epoch for migrations

---

## HeadDoc Implementation

### Purpose

HeadDoc manages epoch-based versioning with CRDT-safe concurrent bumps.

### Key Pattern: Per-Client MAX Aggregation

The naive approach of incrementing a counter breaks with concurrent writes:

```typescript
// BAD: Two clients bump simultaneously
// Both read epoch=2, both set epoch=3
// One bump is lost (higher clientID wins)
setEpoch(epoch + 1);
```

The solution: each client writes to their own key, current epoch is MAX of all:

```
Y.Map('epochs')
  └── "client-123": 3   // Client A's proposal
  └── "client-456": 3   // Client B's proposal
  └── "client-789": 5   // Client C's proposal

getEpoch() → MAX(3, 3, 5) = 5
```

### HeadDoc Code Pattern

```typescript
export function createHeadDoc<T extends ProviderFactoryMap>(options: {
  workspaceId: string;
  providers: T;
}) {
  const { workspaceId, providers } = options;

  // Y.Doc guid is just the workspaceId (no epoch suffix)
  const ydoc = new Y.Doc({ guid: workspaceId });
  const epochsMap = ydoc.getMap<number>('epochs');
  const metaMap = ydoc.getMap<unknown>('meta');

  // Initialize providers
  const providerExports = {} as InferProviderExports<T>;
  for (const [id, factory] of Object.entries(providers)) {
    providerExports[id] = factory({ ydoc });
  }

  const whenSynced = Promise.all(
    Object.values(providerExports).map((p) => p.whenSynced)
  ).then(() => {});

  return {
    ydoc,
    workspaceId,
    providers: providerExports,
    whenSynced,

    /**
     * Get current epoch (MAX of all client proposals).
     */
    getEpoch(): number {
      let max = 0;
      epochsMap.forEach((value) => {
        max = Math.max(max, value);
      });
      return max;
    },

    /**
     * Get this client's own epoch value.
     * May differ from global epoch (for viewing historical epochs).
     */
    getOwnEpoch(): number {
      return epochsMap.get(ydoc.clientID.toString()) ?? 0;
    },

    /**
     * Safely bump to next epoch.
     * Computes MAX + 1 and proposes under this client's ID.
     */
    bumpEpoch(): number {
      const next = this.getEpoch() + 1;
      epochsMap.set(ydoc.clientID.toString(), next);
      return next;
    },

    /**
     * Set this client's epoch (clamped to not exceed global).
     * Use for time-travel to view historical epochs.
     */
    setOwnEpoch(epoch: number): number {
      const globalEpoch = this.getEpoch();
      const clamped = Math.min(epoch, globalEpoch);
      epochsMap.set(ydoc.clientID.toString(), clamped);
      return clamped;
    },

    /**
     * Get all epoch proposals for debugging.
     */
    getEpochProposals(): Map<string, number> {
      const proposals = new Map<string, number>();
      epochsMap.forEach((value, key) => {
        proposals.set(key, value);
      });
      return proposals;
    },

    /**
     * Observe epoch changes.
     */
    observeEpoch(callback: (epoch: number) => void): () => void {
      const handler = () => callback(this.getEpoch());
      epochsMap.observe(handler);
      return () => epochsMap.unobserve(handler);
    },

    // Meta helpers (workspace identity)
    getMeta() {
      return {
        name: metaMap.get('name') as string ?? '',
        icon: metaMap.get('icon') as Icon ?? null,
        description: metaMap.get('description') as string ?? '',
      };
    },

    setMeta(meta: { name?: string; icon?: Icon | null; description?: string }) {
      ydoc.transact(() => {
        if (meta.name !== undefined) metaMap.set('name', meta.name);
        if (meta.icon !== undefined) metaMap.set('icon', meta.icon);
        if (meta.description !== undefined) metaMap.set('description', meta.description);
      });
    },

    async destroy() {
      await Promise.allSettled(
        Object.values(providerExports).map((p) => p.destroy())
      );
      ydoc.destroy();
    },
  };
}
```

---

## HeadDoc Persistence Pattern

```typescript
export function headPersistence(
  ydoc: Y.Doc,
  config: { jsonDebounceMs?: number } = {},
): ProviderExports {
  const { jsonDebounceMs = 500 } = config;
  const workspaceId = ydoc.guid;

  const pathsPromise = (async () => {
    const baseDir = await appLocalDataDir();
    const workspaceDir = await join(baseDir, 'workspaces', workspaceId);
    return {
      workspaceDir,
      binaryPath: await join(workspaceDir, 'head.yjs'),
      jsonPath: await join(workspaceDir, 'head.json'),
    };
  })();

  // Binary persistence (immediate)
  const saveBinary = async () => {
    const { binaryPath } = await pathsPromise;
    const state = Y.encodeStateAsUpdate(ydoc);
    await writeFile(binaryPath, state);
  };

  // JSON mirror (debounced, flattens meta to top level)
  let jsonTimer: ReturnType<typeof setTimeout> | null = null;

  const saveJson = async () => {
    const { jsonPath } = await pathsPromise;
    const metaMap = ydoc.getMap('meta');
    const epochsMap = ydoc.getMap<number>('epochs');

    const flattened = {
      ...metaMap.toJSON(),
      epochs: epochsMap.toJSON(),
    };

    await writeFile(jsonPath, new TextEncoder().encode(
      JSON.stringify(flattened, null, '\t')
    ));
  };

  const scheduleJsonSave = () => {
    if (jsonTimer) clearTimeout(jsonTimer);
    jsonTimer = setTimeout(() => {
      jsonTimer = null;
      saveJson();
    }, jsonDebounceMs);
  };

  const handleUpdate = () => {
    saveBinary();
    scheduleJsonSave();
  };

  ydoc.on('update', handleUpdate);

  return defineExports({
    whenSynced: (async () => {
      const { workspaceDir, binaryPath } = await pathsPromise;
      await mkdir(workspaceDir, { recursive: true }).catch(() => {});

      try {
        const savedState = await readFile(binaryPath);
        Y.applyUpdate(ydoc, new Uint8Array(savedState));
      } catch {
        await saveBinary();
      }

      await saveJson();
    })(),

    destroy() {
      ydoc.off('update', handleUpdate);
      if (jsonTimer) clearTimeout(jsonTimer);
    },
  });
}
```

---

## Registry Pattern (Conceptual)

The Registry was designed but not fully implemented. Here's the pattern:

```typescript
// Registry Y.Doc structure
Y.Doc (guid: "registry")
└── Y.Map('workspaces')
    └── {workspaceId}: true   // Simple presence map

// Or with YKeyValueLww for full definitions:
Y.Doc (guid: "registry")
└── Y.Array('workspaces')   // YKeyValueLww
    └── { key: "ws-123", val: { ...definition }, ts: ... }
    └── { key: "ws-456", val: { ...definition }, ts: ... }
```

### Registry Service Pattern

```typescript
export function createRegistry(options: {
  registryId: string;
  providers: ProviderFactoryMap;
}) {
  const ydoc = new Y.Doc({ guid: options.registryId });
  const workspacesMap = ydoc.getMap<boolean>('workspaces');

  // Or with YKeyValueLww:
  // const workspacesArray = ydoc.getArray('workspaces');
  // const workspaces = new YKeyValueLww(workspacesArray);

  return {
    ydoc,

    listWorkspaceIds(): string[] {
      return Array.from(workspacesMap.keys());
    },

    addWorkspace(id: string) {
      workspacesMap.set(id, true);
    },

    removeWorkspace(id: string) {
      workspacesMap.delete(id);
    },

    hasWorkspace(id: string): boolean {
      return workspacesMap.has(id);
    },

    observe(callback: () => void): () => void {
      workspacesMap.observe(callback);
      return () => workspacesMap.unobserve(callback);
    },
  };
}
```

---

## Epoch-Based Storage Layout

When using HeadDoc with epochs:

```
{appLocalDataDir}/workspaces/{workspaceId}/
├── head.yjs                    # HeadDoc binary
├── head.json                   # HeadDoc mirror (meta + epochs)
└── {epoch}/                    # Epoch folder (0, 1, 2, ...)
    ├── workspace.yjs           # Workspace Y.Doc binary
    ├── definition.json         # Schema mirror
    ├── kv.json                 # KV values mirror
    └── snapshots/              # Revision history
        ├── {timestamp}.ysnap   # Y.Doc snapshot
        └── {timestamp}.json    # Snapshot metadata
```

### Why Epochs?

1. **Schema Migrations**: Bump epoch when schema changes fundamentally
2. **Time Travel**: View historical data by setting own epoch lower
3. **Fresh Start**: Delete epoch folder to start over without losing history
4. **Atomic Versioning**: All clients converge to same epoch via MAX

---

## GC Considerations for Versioned Mode

When using epochs/snapshots, Y.Doc must have `gc: false`:

```typescript
// Versioned mode: gc: false for snapshot capability
const ydoc = new Y.Doc({
  guid: `${workspaceId}-${epoch}`,
  gc: false  // Required for Y.snapshot() to work
});
```

With `gc: false`, use **Y.Map** instead of YKeyValueLww for storage efficiency:
- YKeyValueLww + gc:false = 800x storage bloat
- Y.Map + gc:false = only 2x storage increase

See `docs/articles/ykeyvalue-gc-the-hidden-variable.md` for details.

---

## Reactive HeadDoc (Svelte)

Pattern for reactive epoch state in Svelte:

```typescript
import type { HeadDoc } from '@epicenter/hq';

export function createReactiveHead(head: HeadDoc) {
  let epoch = $state(head.getEpoch());
  let meta = $state(head.getMeta());

  // Subscribe to epoch changes
  const unsubscribeEpoch = head.observeEpoch((newEpoch) => {
    epoch = newEpoch;
  });

  // Subscribe to meta changes
  const metaMap = head.ydoc.getMap('meta');
  const handleMetaChange = () => {
    meta = head.getMeta();
  };
  metaMap.observe(handleMetaChange);

  return {
    get epoch() { return epoch; },
    get meta() { return meta; },

    setMeta: head.setMeta.bind(head),
    bumpEpoch: head.bumpEpoch.bind(head),

    destroy() {
      unsubscribeEpoch();
      metaMap.unobserve(handleMetaChange);
    },
  };
}
```

---

## Future: Versioned Workspace API

When implementing versioned workspaces, the API might look like:

```typescript
// Option 1: Separate function
import { createVersionedWorkspace } from '@epicenter/hq/dynamic';

const head = createHeadDoc({ workspaceId, providers: {...} });
const workspace = createVersionedWorkspace({ headDoc: head, definition });

// Option 2: Flag in definition
const definition = {
  id: 'my-workspace',
  versionControl: true,  // Enables epochs
  ...
};

const workspace = createWorkspace(definition); // Detects flag

// Time travel
workspace.viewEpoch(2);  // Switch to epoch 2
workspace.bumpEpoch();   // Create epoch 3

// Snapshots
const snapshot = await workspace.createSnapshot('Before big change');
await workspace.restoreSnapshot(snapshot);
```

---

## Related Documents

- **Specification**: `specs/20260201T120000-simple-definition-first-workspace.md` - The simple workspace API that replaces HeadDoc for basic use cases
- **Handoff Prompt**: `specs/20260201T120000-simple-definition-first-workspace-handoff.md` - Agent execution prompt
- **GC Decision Guide**: `docs/articles/ykeyvalue-vs-ymap-decision-guide.md` - Why GC setting determines data structure
- **GC Deep Dive**: `docs/articles/ykeyvalue-gc-the-hidden-variable.md` - Storage implications
- **Storage Guide**: `docs/articles/yjs-gc-on-vs-off-storage-guide.md` - Complete GC guide

## Code References

- `packages/epicenter/src/dynamic/head-doc.ts` - HeadDoc implementation (may be archived)
- `apps/epicenter/src/lib/docs/_archive/head.ts` - App-level wrapper (archived)
- `apps/epicenter/src/lib/docs/_archive/head-persistence.ts` - Tauri persistence (archived)
- `apps/epicenter/src/lib/docs/_archive/registry.ts` - Registry implementation (archived)
- `apps/epicenter/src/lib/docs/_archive/registry-persistence.ts` - Registry persistence (archived)
