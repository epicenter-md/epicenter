# Typed URL Search Params (Honeycrisp + Opensidian + Fuji)

Replace stringly-typed `setSearchParam(key, value)` with typed `searchParams` singletons per app. Each app defines a `SearchParams` type, a `DEFAULTS` record, and a batch `update()` that writes all changes in a single `goto()` call.

---

## Design decisions

### Why typed singletons over the old `setSearchParam(key, value)`

| | Old (`setSearchParam`) | New (`searchParams.update()`) |
|---|---|---|
| **Typing** | `key: string`: typos compile | `Partial<SearchParams>`: typos are type errors |
| **Batching** | 3 separate `goto()` calls for `selectFolder` | 1 `goto()` via object literal |
| **URL construction** | Manual string: `` `${pathname}${search ? '?' + search : ''}` `` | `new URL(page.url)` clone + `goto(url)` |
| **Default elision** | Caller decides per call site | Centralized in `DEFAULTS` record |
| **Schema definition** | Implicit across multiple files | Single `SearchParams` type per app |

### Why separate from domain state

`view.svelte.ts` imports `notesState`. `notesState` needs to clear `?note` on delete. If URL state lived inside `viewState`, `notesState` would import `viewState` → circular dep. Extracting `searchParams` as a leaf dependency (only imports `$app/*`) breaks the cycle.

```
search-params.svelte.ts          ← leaf (only imports $app/*)
    ▲           ▲           ▲
    │           │           │
view.svelte.ts  notes.svelte.ts  folders.svelte.ts
    │               │
    ▼               │
notesState ◄────────┘
```

### Why `goto()` and not `replaceState()`

SvelteKit's `replaceState(url, state)` from `$app/navigation` is for shallow routing with `$page.state`. Our use case is search params, not page state. `goto(url, { replaceState: true })` is the documented pattern (per SvelteKit's state management docs).

### Why no shared package

Each app has 2-5 params with different schemas. A generic `createSearchParams<T>()` factory adds a layer of abstraction over 40 lines of app-specific code. Not worth it.

### What shadcn-svelte does

shadcn-svelte's data table examples keep pagination/sorting/filtering in local `$state`, not URL params. URL persistence is entirely the app's responsibility. The boundary: our `searchParams` singleton feeds shadcn components via props.

---

## Pattern

```ts
// Per-app: apps/{app}/src/lib/search-params.svelte.ts
import { goto } from '$app/navigation';
import { page } from '$app/state';

type SearchParams = { /* app-specific schema */ };
const DEFAULTS: SearchParams = { /* default values: elided from URL */ };

function createSearchParams() {
  function update(changes: Partial<SearchParams>) {
    const url = new URL(page.url);
    for (const [key, value] of Object.entries(changes)) {
      const def = DEFAULTS[key as keyof SearchParams];
      if (value === null || value === '' || value === def) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  return {
    get someParam() { /* read from page.url.searchParams */ },
    update,
  };
}

export const searchParams = createSearchParams();
```

---

## App 1: Honeycrisp

### URL param schema

| Getter | Param | Default (elided) | Type |
|---|---|---|---|
| `searchParams.folder` | `?folder=<id>` | `null` (all notes) | `FolderId \| null` |
| `searchParams.note` | `?note=<id>` | `null` (no note open) | `NoteId \| null` |
| `searchParams.sort` | `?sort=dateCreated\|title` | `dateEdited` | `SortBy` |
| `searchParams.q` | `?q=<text>` | `''` (empty) | `string` |
| `searchParams.isDeletedView` | `?view=deleted` | `false` | `boolean` |

### Files changed

- [x] **`search-params.svelte.ts`**: New typed singleton with `SearchParams` type, `DEFAULTS`, batch `update()`, reactive getters.
- [x] **`state/view.svelte.ts`**: Reads from `searchParams.*` getters. State transitions use `searchParams.update({ ... })` for atomic multi-param changes. Removed `page` import and all `setSearchParam` calls.
- [x] **`state/notes.svelte.ts`**: Replaced `page.url.searchParams.get('note')` + `setSearchParam('note', null)` with `searchParams.note` and `searchParams.update({ note: null })`.
- [x] **`state/folders.svelte.ts`**: Replaced `page.url.searchParams.get('folder')` + two `setSearchParam` calls with `searchParams.folder === folderId` + `searchParams.update({ folder: null, note: null })`.
- [x] **`search-params.ts`**: Deleted (replaced by `.svelte.ts` version).

---

## App 2: Opensidian

### URL param schema

| Getter | Param | Default (elided) | Type |
|---|---|---|---|
| `searchParams.file` | `?file=<id>` | `null` (no file) | `FileId \| null` |
| `searchParams.chat` | `?chat=<id>` | `null` (no chat) | `ConversationId \| null` |

### Files changed

- [x] **`search-params.svelte.ts`**: New typed singleton.
- [x] **`state/fs-state.svelte.ts`**: Replaced `setSearchParam('file', ...)` with `searchParams.update({ file: ... })`. Replaced `page.url.searchParams.get('file')` reads with `searchParams.file`. Updated `selectedNode`, `selectedPath` derived state, and `startCreate` to use `searchParams.file`.
- [x] **`chat/chat-state.svelte.ts`**: Replaced all `setSearchParam('chat', ...)` with `searchParams.update({ chat: ... })`. `activeConversationId` now derives from `searchParams.chat` instead of `page.url.searchParams.get('chat')`.
- [x] **`search-params.ts`**: Deleted (replaced by `.svelte.ts` version).

**NOT moved** (same evaluation as before):
- `search-state.svelte.ts`: ephemeral command palette search
- `sidebar-search-state.svelte.ts`: persisted via `createPersistedState`
- `editor-state.svelte.ts`: layout/runtime state
- `terminal-state.svelte.ts`: not linkable
- `skill-state.svelte.ts`: runtime skill loader

---

## App 3: Fuji

### URL param schema

| Getter | Param | Default (elided) | Type |
|---|---|---|---|
| `viewState.viewMode` | `?view=timeline` | `table` | `ViewMode` |
| `viewState.sortBy` | `?sort=updatedAt\|...` | `date` | `SortBy` |
| `viewState.searchQuery` | `?q=<text>` | `''` | `string` |

### Files changed

- [x] **`view-state.svelte.ts`**: Replaced inline `setSearchParam()` with a local typed `update()` function. No separate file needed. Fuji's URL state is only consumed by this module.

---

## Risks and edge cases

1. **`goto()` is async**: URL update is near-instant with `replaceState: true` and no server load. Code that writes then immediately reads should use the value it just set from local scope, not re-read from `page.url.searchParams`.

2. **Circular deps**: `searchParams` is a leaf dependency. `view.svelte.ts` and `notes.svelte.ts`/`folders.svelte.ts` both import it without cycles.

3. **Workspace action context**: `defineMutation` handlers run outside Svelte context. Selection clearing stays in the Svelte layer (`foldersState.deleteFolder()`), not in the mutation handler.

4. **Initial load**: `?note=abc123` is immediately available via `page.url.searchParams`. Workspace data may not be ready yet, but components already guard on `workspace.whenReady`.

5. **Chat reconciliation**: `reconcileHandles()` runs synchronously from observers. `searchParams.update()` calls `goto()` which may schedule a microtask. Handle lookup immediately after setting the param uses the ID value directly rather than re-reading from URL.

---

## Review

### What changed

Replaced the stringly-typed `setSearchParam(key: string, value: string | null)` utility (copy-pasted across 3 apps) with per-app typed `searchParams` singletons. Each app now has:

1. A `SearchParams` type defining the complete URL contract
2. A `DEFAULTS` record for automatic default-elision
3. A batch `update(changes)` function that writes multiple params in one `goto()` call
4. Reactive getters that read from `page.url.searchParams` with proper type casting

### Key improvements

- **Type safety**: `searchParams.update({ foler: null })` → TypeScript error. No more magic strings.
- **Atomic transitions**: `selectFolder()` is now one `goto()` call, not three sequential ones racing against SvelteKit's navigation.
- **Single schema**: Every param, its type, and its default defined in one place per app.
- **Cleaner URL construction**: `new URL(page.url)` clone + mutate + `goto(url)` instead of manual string building.

### Files touched

| App | Files | Change |
|---|---|---|
| Honeycrisp | 5 files (1 new, 3 modified, 1 deleted) | Typed singleton + consumer updates |
| Opensidian | 4 files (1 new, 2 modified, 1 deleted) | Typed singleton + consumer updates |
| Fuji | 1 file (modified) | Inline typed `update()` replacing `setSearchParam` |
