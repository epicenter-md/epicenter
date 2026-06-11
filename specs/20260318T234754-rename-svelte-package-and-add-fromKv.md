# Rename @epicenter/svelte-utils → @epicenter/svelte, add `fromKv` + `fromTable`, standardize tsconfig

## Problem

Two repeating patterns across the codebase:

**1. KV state boilerplate**: `$state(kv.get(key))` + `kv.observe(key, callback)` appears 5 times across 2 apps. Each instance is 6-8 lines of identical shape.

**2. Table state boilerplate**: `$state<Row[]>(readAll())` + `table.observe(() => { items = readAll() })` appears 7+ times across 4 apps. The naive array approach re-fetches ALL rows on every change, even when only one row changed. The table observer already gives `changedIds`: we should do granular O(changed) updates.

**3. tsconfig drift**: Base config is ES2022, but packages inconsistently override with ESNext, mixed casing, and missing DOM.Iterable.

## Solution

### 1. Rename package: `@epicenter/svelte-utils` → `@epicenter/svelte`

- Change `name` in `packages/svelte-utils/package.json`
- Update all import sites (whispering has 3 files importing from it)
- Keep directory as `packages/svelte-utils` for now (separate PR for directory rename)
- Run `bun install` to regenerate lockfile

### 2. Standardize tsconfig to ESNext

**Base**: `lib: ["ESNext"]` (up from `["ES2022"]`)

ESNext is correct for a private monorepo targeting only modern runtimes (Tauri WebView, Chrome extension, Cloudflare Workers). It's a superset of ES2024. Includes `Symbol.dispose`, `Promise.withResolvers`, `Object.groupBy`, Set methods, Iterator helpers, and everything else. No manual bumping needed. Pin to a specific version only when publishing public packages.

**Standardize individual packages**: All packages use `ESNext`. Packages needing DOM use `["ESNext", "DOM", "DOM.Iterable"]`. TS lib arrays don't merge on `extends`: they replace. So each package needing DOM must list the full set.

### 3. Add `fromKv` utility

**File**: `packages/svelte-utils/src/fromKv.svelte.ts`

```typescript
import type { InferKvValue, KvDefinitions, KvHelper } from '@epicenter/workspace';

/**
 * Create a reactive binding to a single workspace KV key.
 *
 * Mirrors Svelte 5's `fromStore()` pattern. Wraps an external data source
 * into a reactive `{ current }` box. Reading `.current` is reactive (triggers
 * re-renders). Writing `.current` calls `kv.set()` under the hood.
 *
 * The observer fires on both local and remote changes (Yjs CRDT sync).
 * On delete, falls back to the KV definition's `defaultValue` via `kv.get()`.
 *
 * @example
 * ```typescript
 * const selectedFolderId = fromKv(workspaceClient.kv, 'selectedFolderId');
 *
 * // Read (reactive):
 * console.log(selectedFolderId.current); // FolderId | null
 *
 * // Write (calls kv.set):
 * selectedFolderId.current = newFolderId;
 * ```
 */
export function fromKv<
  TDefs extends KvDefinitions,
  K extends keyof TDefs & string,
>(
  kv: KvHelper<TDefs>,
  key: K,
): { current: InferKvValue<TDefs[K]>; destroy: () => void } {
  let value = $state(kv.get(key));

  const unobserve = kv.observe(key, (change) => {
    value = change.type === 'set' ? change.value : kv.get(key);
  });

  return {
    get current() {
      return value;
    },
    set current(newValue: InferKvValue<TDefs[K]>) {
      kv.set(key, newValue);
    },
    destroy: unobserve,
  };
}
```

### 4. Add `fromTable` utility

**File**: `packages/svelte-utils/src/fromTable.svelte.ts`

Uses a `SvelteMap` for granular per-row reactivity. The table observer gives `changedIds`, so we update only the rows that changed. O(changed) not O(all).

```typescript
import type { BaseRow, TableHelper } from '@epicenter/workspace';
import { SvelteMap } from 'svelte/reactivity';

/**
 * Create a reactive SvelteMap binding to a workspace table.
 *
 * Returns a `SvelteMap<id, Row>` that stays in sync with the underlying
 * Yjs table via granular per-row updates. Only changed rows trigger
 * re-renders. Not the entire collection.
 *
 * Read-only. Mutations go through `table.set()`, `table.update()`, etc.
 * The observer picks up changes from both local writes and remote CRDT sync.
 *
 * @example
 * ```typescript
 * const entries = fromTable(workspaceClient.tables.entries);
 *
 * // Per-item access (reactive):
 * const entry = entries.get(id);
 *
 * // Iterate (reactive):
 * for (const [id, entry] of entries) { ... }
 *
 * // Array access:
 * const all = [...entries.values()];
 *
 * // Derived state:
 * const filtered = $derived([...entries.values()].filter(e => !e.deletedAt));
 * ```
 */
export function fromTable<TRow extends BaseRow>(
  table: TableHelper<TRow>,
): SvelteMap<string, TRow> & { destroy: () => void } {
  const map = new SvelteMap<string, TRow>();

  // Seed with current valid rows
  for (const row of table.getAllValid()) {
    map.set(row.id, row);
  }

  // Granular updates: only touch changed rows
  const unobserve = table.observe((changedIds) => {
    for (const id of changedIds) {
      const result = table.get(id);
      switch (result.status) {
        case 'valid':
          map.set(id, result.row);
          break;
        case 'not_found':
        case 'invalid':
          map.delete(id);
          break;
      }
    }
  });

  return Object.assign(map, { destroy: unobserve });
}
```

### 5. Migrate honeycrisp `view.svelte.ts` (fromKv)

**Before** (18+ lines): 3 `$state` + 3 `kv.observe` pairs
**After** (3 lines): 3 `fromKv` calls

All reads: `selectedFolderId` → `selectedFolderId.current`
All writes: `workspaceClient.kv.set('selectedFolderId', v)` → `selectedFolderId.current = v`

### 6. Migrate fuji `+page.svelte` (fromKv + fromTable)

- KV observers (`selectedEntryId`, `viewMode`) → `fromKv` at script top-level
- Table observer (`entries`) → `fromTable` at script top-level
- Remove the `$effect` wrapper (observers move out of effect scope)
- Derived state adapts: `entries.find(...)` → `entries.get(id)` or `[...entries.values()].filter(...)`

### 7. Migrate honeycrisp notes + folders (fromTable)

- `notes.svelte.ts`: Replace `let allNotes = $state(readNotes()); table.observe(() => { allNotes = readNotes() })` → `fromTable(tables.notes)`
- `folders.svelte.ts`: Same pattern → `fromTable(tables.folders)`
- Derived state (`notes`, `deletedNotes`, `noteCounts`) adapts to read from SvelteMap `.values()`

### 8. Migrate tab-manager simple observers (fromTable)

- `saved-tab-state.svelte.ts`: `let tabs = $state(readAll()); table.observe(...)` → `fromTable(tables.savedTabs)`
- `bookmark-state.svelte.ts`: Same pattern → `fromTable(tables.bookmarks)`
- `tool-trust.svelte.ts`: Already uses SvelteMap, but with inefficient clear+repopulate. `fromTable` gives granular updates.

## Design decisions

### Why `from*` (not `use*` or `create*`)
Svelte 5's own `fromStore()` establishes the convention: convert an external data source into reactive Svelte state. The `from*` family scales: `fromKv`, `fromTable`, future `fromKvAll`.

### Why `.current` on `fromKv` but not `fromTable`
`fromKv` wraps a scalar value → needs a box (`{ current }`). `fromTable` wraps a collection → IS a collection (SvelteMap). Same distinction as `$state(value)` vs `SvelteMap`.

### Why `destroy` (not `dispose` or `Symbol.dispose`)
- `destroy` matches the workspace codebase convention (extensions, WorkspaceClient all use `destroy`)
- `Symbol.dispose` requires `using` syntax, but `using` is block-scoped (doesn't match SPA-lifetime factory usage) and Svelte's `<script>` blocks don't support it
- Cost is one line per utility. Callers who don't need cleanup ignore it.

### Why single entry point (no subpath exports)
With 3 utilities (`fromKv`, `fromTable`, `createPersistedState`), one entry point keeps imports simple. Revisit at ~10 exports.

### Why ESNext (not ES2024)
- Private monorepo targeting only modern runtimes (Tauri, Chrome extension, Cloudflare Workers)
- ESNext ⊃ ES2024. Includes everything ES2024 has plus newer proposals
- No manual bumping needed; TypeScript auto-includes latest features
- Pin to a specific version only when publishing public packages
- Several packages already use ESNext. Standardizing reduces inconsistency

### Why SvelteMap for tables (not array wholesale replacement)
- Table observer gives `changedIds`: do O(changed) updates, not O(all) re-fetches
- SvelteMap provides per-key reactivity. Only components reading changed rows re-render
- Matches existing pattern in browser-state, chat-state, and tool-trust
- Strictly better than array replacement in all cases

## Todo

### Phase 1: Foundation
- [x] Rename package in `packages/svelte-utils/package.json`: `@epicenter/svelte-utils` → `@epicenter/svelte`
- [x] Update whispering imports: `@epicenter/svelte-utils` → `@epicenter/svelte` (3 files)
- [x] Bump `tsconfig.base.json` lib from `["ES2022"]` to `["ESNext"]`
- [x] Standardize all package/app tsconfigs: replace mixed `ESNext`/`es2022` lib overrides with consistent `ESNext` (12 files)
- [x] Add `@epicenter/workspace` as a dependency to `@epicenter/svelte` (for types)
- [x] Create `packages/svelte-utils/src/fromKv.svelte.ts`
- [x] Create `packages/svelte-utils/src/fromTable.svelte.ts`
- [x] Export both from `packages/svelte-utils/src/index.ts`

### Phase 2: First migrations (honeycrisp + fuji)
- [x] Add `@epicenter/svelte` as dependency to honeycrisp `package.json`
- [x] Migrate honeycrisp `view.svelte.ts`: 3 KV state+observer pairs → 3 `fromKv` calls
- [x] Add `@epicenter/svelte` as dependency to fuji `package.json`
- [x] Migrate fuji `+page.svelte`: 2 KV observers → `fromKv`, 1 table observer → `fromTable`

### Phase 3: Full rollout (remaining simple observers)
- [x] Migrate honeycrisp `notes.svelte.ts`: array+observe → `fromTable`
- [x] Migrate honeycrisp `folders.svelte.ts`: array+observe → `fromTable`
- [x] Migrate tab-manager `saved-tab-state.svelte.ts`: array+observe → `fromTable`
- [x] Migrate tab-manager `bookmark-state.svelte.ts`: array+observe → `fromTable`
- [x] Migrate tab-manager `tool-trust.svelte.ts`: clear+repopulate SvelteMap → `fromTable`

### Verify
- [x] Run `bun install` to regenerate lockfile
- [x] Typecheck all affected packages (all errors are pre-existing: workspace mdast/NumberKeysOf, Editor Level type, defineKv arity, YText/YXmlFragment, Record generic)

### Future work (separate specs)
- Rename directory `packages/svelte-utils` → `packages/svelte`
- Migrate tab-manager browser-state (complex nested SvelteMap: custom logic, doesn't fit `fromTable`)
- Migrate tab-manager chat-state (multi-table reconciliation: custom logic)
- Migrate opensidian fs-state (version counter + requestAnimationFrame batching: different pattern)
- `fromKvAll` utility (SvelteMap over all KV keys, replaces whispering workspace-settings pattern)
- Add `Symbol.dispose` alongside `destroy` when Svelte script blocks support `using`

## Review

### Changes made

**Phase 1: Foundation:**
- Renamed `@epicenter/svelte-utils` → `@epicenter/svelte` in `packages/svelte-utils/package.json`
- Updated 3 whispering source files + `apps/whispering/package.json` to use new package name
- Bumped `tsconfig.base.json` lib from `["ES2022"]` → `["ESNext"]`
- Standardized 12 tsconfig lib overrides to `["ESNext"]` or `["ESNext", "DOM", "DOM.Iterable"]`
- Added `@epicenter/workspace` as dependency to `@epicenter/svelte`
- Created `fromKv.svelte.ts` and `fromTable.svelte.ts` with full JSDoc, exported from `index.ts`
- Removed `NodeNext` module/moduleResolution from svelte-utils tsconfig (incompatible with workspace's bundler resolution)

**Phase 2: First migrations:**
- Added `@epicenter/svelte` dep to honeycrisp + fuji `package.json`
- Migrated honeycrisp `view.svelte.ts`: 3 `$state` + 3 `kv.observe` → 3 `fromKv` calls. Updated all `.current` reads/writes.
- Migrated fuji `+page.svelte`: removed `$effect` wrapper, replaced 2 KV observers with `fromKv`, 1 table observer with `fromTable`. Updated derived state to use SvelteMap `.get()` and `[...values()]`.

**Phase 3: Full rollout:**
- Migrated honeycrisp `notes.svelte.ts`: replaced `allNotes` array + observe with `fromTable`. Derived `notes`, `deletedNotes`, `noteCounts` now read from `[...allNotesMap.values()]`.
- Migrated honeycrisp `folders.svelte.ts`: replaced `folders` array + observe with `fromTable`.
- Migrated tab-manager `saved-tab-state.svelte.ts`: replaced `tabs` array + observe with `fromTable`.
- Migrated tab-manager `bookmark-state.svelte.ts`: replaced `bookmarks` array + observe with `fromTable`.
- Migrated tab-manager `tool-trust.svelte.ts`: replaced inefficient clear+repopulate SvelteMap with `fromTable`. Trust values accessed via `.trust` property on the row.

**Verification:**
- `bun install` succeeded (tab-manager `wxt prepare` postinstall fails due to pre-existing nypm/tinyexec issue)
- All migrated files typecheck clean: zero new errors introduced
- Pre-existing errors in workspace (mdast, NumberKeysOf), Editor.svelte (Level), fuji workspace.ts (defineKv arity), UI (Record generic)
