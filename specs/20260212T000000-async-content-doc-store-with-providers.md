# Async ContentDocStore with Injectable Providers

**Date**: 2026-02-12T00:00:00
**Status**: Implemented
**Parent**: `specs/20260209T000000-simplify-content-doc-lifecycle.md`
**See also**: `specs/20260208T000000-yjs-filesystem-spec.md`: two-layer architecture

## Problem

`ContentDocStore.ensure()` is synchronous and returns a `Y.Doc` that may be empty. Content docs have no persistence. They're pure in-memory. When `readFile()` calls `ensure(id)`, the doc might not have content yet if persistence (IndexedDB) or sync (WebSocket) haven't delivered it.

This means:

- **`readFile()` can return empty string** for a file that has persisted content in IndexedDB
- **`grep -r` can miss content** across files that haven't been loaded from storage
- **No persistence survives page reload**: content docs are ephemeral

The fix: make `ensure()` async, attach persistence providers per doc, await readiness before returning.

## Constraints

- `IFileSystem.readFile()` is already async: can await readiness
- `y-indexeddb` provides `whenSynced` promise per doc (~10-20ms per small doc)
- Workspace scale: typically 50-500 files (not thousands)
- Tests run in Bun: no IndexedDB available in test environment
- `ProviderFactory` type already exists in `provider-types.ts` for doc-level providers

---

## Design

### Inject provider factories at store creation time

Provider factories are a **configuration concern**, not a per-file concern. You want IndexedDB persistence for every content doc, not selectively. Pass factories once when creating the store:

```typescript
// Creation: configure providers once
const store = createContentDocStore([indexeddbPersistence]);

// Usage: callers don't know or care about providers
const ydoc = await store.ensure(fileId);  // hydrated, ready to use
```

Why not on `ensure()`? YjsFileSystem calls `ensure()` in 6 places. Threading provider config through every call site is noise. The store owns the "how do I hydrate a doc" question.

### Reuse existing `ProviderFactory` type

`ProviderFactory` from `dynamic/provider-types.ts` was designed for exactly this:

```typescript
type ProviderContext = { ydoc: Y.Doc };
type ProviderFactory = (context: ProviderContext) => Lifecycle;
```

Takes `{ ydoc }` (the doc's guid is the FileId, accessible via `ydoc.guid`). Returns `Lifecycle` (`whenSynced` + `destroy`). Factories are **always synchronous**: async initialization tracked via `whenSynced`.

### No LRU cache, no eviction

Docs stay in memory after first load. At workspace scale (50-500 files, 1-50KB each), this is ~0.5-25MB. Not a concern for a desktop app.

### No providers = instant

When `providerFactories` is empty (tests, headless), `ensure()` uses `Promise.resolve(ydoc)`: resolves in the same microtask. Zero async overhead for tests.

---

## ContentDocStore interface change

```typescript
// Before
export type ContentDocStore = {
  ensure(fileId: FileId): Y.Doc;
  destroy(fileId: FileId): void;
  destroyAll(): void;
};

// After
export type ContentDocStore = {
  ensure(fileId: FileId): Promise<Y.Doc>;
  destroy(fileId: FileId): Promise<void>;
  destroyAll(): Promise<void>;
};
```

---

## Implementation

### `createContentDocStore(providerFactories?)`

```typescript
import * as Y from 'yjs';
import type { ProviderFactory } from '../dynamic/provider-types.js';
import { defineExports, type Lifecycle } from '../shared/lifecycle.js';
import type { ContentDocStore, FileId } from './types.js';

type DocEntry = {
  ydoc: Y.Doc;
  providers: Lifecycle[];
  whenReady: Promise<Y.Doc>;
};

export function createContentDocStore(
  providerFactories: ProviderFactory[] = [],
): ContentDocStore {
  const docs = new Map<FileId, DocEntry>();

  return {
    ensure(fileId: FileId): Promise<Y.Doc> {
      const existing = docs.get(fileId);
      if (existing) return existing.whenReady;

      const ydoc = new Y.Doc({ guid: fileId, gc: false });

      // Factories are synchronous; async init tracked via whenSynced
      const providers: Lifecycle[] = [];
      try {
        for (const factory of providerFactories) {
          const result = factory({ ydoc });
          providers.push(defineExports(result as Record<string, unknown>));
        }
      } catch (err) {
        // Clean up partially-created providers on factory error
        for (const p of providers) p.destroy();
        ydoc.destroy();
        throw err;
      }

      const whenReady =
        providers.length === 0
          ? Promise.resolve(ydoc)
          : Promise.all(providers.map((p) => p.whenSynced)).then(() => ydoc);

      docs.set(fileId, { ydoc, providers, whenReady });
      return whenReady;
    },

    async destroy(fileId: FileId): Promise<void> {
      const entry = docs.get(fileId);
      if (!entry) return;
      await Promise.allSettled(entry.providers.map((p) => p.destroy()));
      entry.ydoc.destroy();
      docs.delete(fileId);
    },

    async destroyAll(): Promise<void> {
      const entries = Array.from(docs.values());
      await Promise.allSettled(
        entries.flatMap((e) => e.providers.map((p) => p.destroy())),
      );
      for (const entry of entries) entry.ydoc.destroy();
      docs.clear();
    },
  };
}
```

**Key behaviors:**

| Behavior | How |
|---|---|
| Concurrent deduplication | Map entry set synchronously before any await. Second `ensure()` for same fileId returns same promise. |
| No providers = instant | `Promise.resolve(ydoc)`: same microtask resolution |
| Factory error cleanup | try/catch around factory loop: partially-created providers destroyed |
| Provider cleanup order | Providers destroyed before Y.Doc (mirrors workspace pattern from `create-workspace.ts`) |
| `destroyAll` resilience | `Promise.allSettled`: one failing provider doesn't block others |

### `YjsFileSystem` changes

**Constructor**: accept optional providers:

```typescript
constructor(
  private filesTable: TableHelper<FileRow>,
  private cwd: string = '/',
  options?: { providers?: ProviderFactory[] },
) {
  this.index = createFileSystemIndex(filesTable);
  this.store = createContentDocStore(options?.providers);
}
```

Backward-compatible. Existing callers (`new YjsFileSystem(ws.tables.files)`) keep working.

**Add `await` to all call sites:**

| Method | Line | Change |
|---|---|---|
| `destroy()` | 49 | `await this.store.destroyAll()`: make method async |
| `readFile()` | 127 | `await this.store.ensure(id)` |
| `readFileBuffer()` | 139 | `await this.store.ensure(id)` |
| `writeFile()` | 172 | `await this.store.ensure(id)` |
| `appendFile()` | 205 | `await this.store.ensure(id)` |
| `rm()` | 308 | `await this.store.destroy(id)` |
| `cp()` | 332 | `await this.store.ensure(srcId)` |
| `softDeleteDescendants()` | 462 | `await this.store.destroy(cid)`: make method async |

All methods are already async except `destroy()` and `softDeleteDescendants()`: both become async.

---

## Usage examples

### Web (IndexedDB persistence)

```typescript
import { IndexeddbPersistence } from 'y-indexeddb';
import { defineExports } from '../shared/lifecycle.js';

const indexeddbPersistence: ProviderFactory = ({ ydoc }) => {
  const persistence = new IndexeddbPersistence(ydoc.guid, ydoc);
  return defineExports({
    whenSynced: persistence.whenSynced,
    destroy: () => persistence.destroy(),
  });
};

const fs = new YjsFileSystem(ws.tables.files, '/', {
  providers: [indexeddbPersistence],
});

// Every readFile() now returns hydrated content from IndexedDB
const content = await fs.readFile('/docs/api.md');
```

### Desktop (file-based persistence)

```typescript
const filePersistence = (dataDir: string): ProviderFactory => ({ ydoc }) => {
  const filePath = `${dataDir}/content/${ydoc.guid}.yjs`;
  // ... load from file, auto-save on update
  return defineExports({ whenSynced, destroy });
};

const fs = new YjsFileSystem(ws.tables.files, '/', {
  providers: [filePersistence('/app/data')],
});
```

### Tests (no providers)

```typescript
// Zero-arg: no providers, instant ensure
const store = createContentDocStore();
const fs = new YjsFileSystem(ws.tables.files);

// ensure() resolves immediately, docs start empty (filled by test writes)
await fs.writeFile('/test.txt', 'hello');
expect(await fs.readFile('/test.txt')).toBe('hello');
```

---

## Performance

| Scenario | No providers (tests) | With IndexedDB |
|---|---|---|
| First `readFile()` | ~0ms (resolved promise) | ~10-20ms (IndexedDB load) |
| Subsequent `readFile()` same file | ~0ms (map lookup) | ~0ms (doc in memory) |
| `grep -r` 100 files (first time) | ~5ms (serialize only) | ~1-2s (100 IndexedDB loads, serial) |
| `grep -r` 100 files (cached) | ~5ms | ~5ms |

First grep pays the IndexedDB cost. After that, all docs are in memory. For AI agents, 1-2 seconds on first grep is negligible (LLM inference dominates). For interactive use, acceptable for a one-time cost.

---

## Files to modify

| File | Change |
|---|---|
| `packages/epicenter/src/filesystem/types.ts` | `ContentDocStore` type: async signatures |
| `packages/epicenter/src/filesystem/content-doc-store.ts` | Core implementation: provider factories, async ensure, lifecycle tracking |
| `packages/epicenter/src/filesystem/yjs-file-system.ts` | Add `await` to 8 call sites, accept providers in constructor |
| `packages/epicenter/src/filesystem/content-doc-store.test.ts` | Make tests async, add provider-specific tests |
| `packages/epicenter/src/filesystem/yjs-file-system.test.ts` | `getTimelineLength` helper at line 374: make async, update ~7 callers |

## Files referenced (no changes)

| File | Why |
|---|---|
| `packages/epicenter/src/dynamic/provider-types.ts` | `ProviderFactory` type to reuse |
| `packages/epicenter/src/shared/lifecycle.ts` | `Lifecycle` type, `defineExports()` helper |
| `packages/epicenter/src/extensions/persistence/web.ts` | IndexedDB persistence pattern to follow |
| `packages/epicenter/src/extensions/persistence/desktop.ts` | File persistence pattern to follow |

## Testing

```bash
bun test packages/epicenter/src/filesystem/
```

Existing tests pass with `await` additions. New tests validate:
- Provider factories run and `whenSynced` is awaited
- Concurrent `ensure()` calls deduplicated (factory called once)
- `destroy()` calls provider `destroy()`
- `destroyAll()` cleans up all providers
- Factory throw during `ensure()` cleans up partial providers
