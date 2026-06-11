# Opensidian: Decouple Workspace from fsState

## Problem

`createFsState()` does two jobs: infrastructure setup (workspace + filesystem) and UI reactive state. It proxies infra internals (`fs`, `documents`, `sqliteIndex`) through its return object, making fsState the single gateway to everything. This couples workspace config to Svelte runes and prevents reuse/testing of the workspace layer independently.

## Solution

Split into two modules following the monorepo convention (tab-manager, whispering):

```
state/
  workspace.ts        ← NEW: pure TypeScript, no Svelte. Creates workspace + filesystem.
  fs-state.svelte.ts  ← MODIFIED: imports workspace, owns only UI state + reactivity bridge.
```

### workspace.ts (pure infra, zero Svelte)

Owns:
- `createWorkspace()` call with table definitions and extensions
- `createYjsFileSystem()` call
- Exports: `fs`, `documents`, `filesDb`, `sqliteIndex`

Does NOT own:
- Any `$state`, `$derived`, `$effect`
- UI concepts (active file, open tabs, dialogs, focus)

### fs-state.svelte.ts (pure UI state)

Receives workspace as import (not dependency injection. It's a singleton anyway).

Owns:
- `$state` reactive values (version, activeFileId, openFileIds, focusedId, dialog state)
- `$derived` computations (rootChildIds, selectedNode, selectedPath)
- rAF-coalesced observer (the `void version` bridge)
- Reactive wrappers: `getRow()`, `getChildIds()`, `getPathForId()`, `walkTree()`: these add `void version` tracking
- All `actions` (selectFile, closeFile, toggleExpand, focus, dialog open/close, CRUD operations)
- `destroy()` cleanup

Does NOT own:
- Workspace creation or extension config
- Raw `fs`, `documents`, `sqliteIndex`: these are no longer proxied

### Consumer changes

| Consumer | Currently | After |
|---|---|---|
| Toolbar.svelte `loadSampleData()` | `fsState.fs.mkdir()` | `import { fs } from '$lib/state/workspace'` |
| ContentEditor.svelte | `fsState.documents.open(id)` | `import { documents } from '$lib/state/workspace'` |
| window.fsState debug | `fsState.sqliteIndex` | Also expose workspace on window |
| fs-state.svelte.ts internally | `fs.writeFile()` in actions | `import { fs, documents } from './workspace'` |

## Task List

- [x] 1. Create `state/workspace.ts`: extract workspace + filesystem creation
- [x] 2. Update `fs-state.svelte.ts`: import from workspace, remove infra creation, drop `fs`/`documents`/`sqliteIndex` from return object
- [x] 3. Update Toolbar.svelte: import `fs` from workspace for `loadSampleData`
- [x] 4. Update ContentEditor.svelte: import `documents` from workspace
- [x] 5. Update window debug exposure: expose workspace on window in workspace.ts
- [x] 6. Verify build passes (`bun --bun vite build`)
- [ ] 7. Stage and commit

## Review

### Summary

Split `createFsState()` into two modules:

- **`workspace.ts`** (52 lines): Pure TypeScript. Creates the Yjs workspace with `filesTable`, wires `indexeddbPersistence` and `sqliteIndex` extensions, creates `YjsFileSystem`. Exports `fs`, `documents`, `filesDb`, `sqliteIndex`. Also exposes `window.workspace` for dev console access.
- **`fs-state.svelte.ts`** (358 lines, down from 376): Imports workspace singletons instead of creating them. Removed `fs`, `documents`, `sqliteIndex` from return object. Replaced 4 occurrences of `ws.tables.files` with `filesDb`. All reactive state, derived computations, actions, and destroy() unchanged.

### Consumer changes

- **Toolbar.svelte**: Removed `const { fs } = fsState` destructure, added `import { fs } from '$lib/state/workspace'`. All `fs.mkdir()`/`fs.writeFile()` calls unchanged.
- **ContentEditor.svelte**: Added `import { documents } from '$lib/state/workspace'`. Changed `fsState.documents.open(id)` → `documents.open(id)`. The `fsState.activeFileId` guard stays (UI state).
- **All other components**: No changes needed: they only access UI state/actions through `fsState`.

### Verification

- LSP diagnostics: 0 errors across all 4 changed files
- Build: `bun --bun vite build` passes (SSR + client, 5412/5390 modules)
- No behavior changes: pure structural refactor
