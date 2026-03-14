# Migrate Filesystem Package to Document Binding API

> **Note**: The `.docs` access pattern described here was replaced by `client.documents` — see specs/20260221T204200-documents-top-level-namespace.md
> **Content model note**: The "two content access paths" design described in this spec's review section is superseded by `specs/20260313T224500-unify-document-content-model.md`. The dual model (handle Y.Text vs filesystem timeline) causes silent data loss and is being unified on the timeline model.

**Date**: 2026-02-19
**Status**: Complete
**Author**: AI-assisted
**Depends on**: PR #1379 (table-level document API)

## Overview

Migrate `packages/filesystem` and `apps/fs-explorer` from the standalone `ContentOps` / `createContentDocStore` pattern to the table-level document binding API introduced in PR #1379. Then deprecate and remove the standalone content doc store.

## Motivation

### Current State

The filesystem package manages per-file content Y.Docs through two standalone modules:

```typescript
// packages/filesystem/src/content-doc-store.ts
export function createContentDocStore(
	providerFactories?: ProviderFactory[],
): ContentDocStore {
	const docs = new Map<FileId, DocEntry>();
	return {
		ensure(fileId) {
			/* creates Y.Doc, runs providers, returns whenReady */
		},
		destroy(fileId) {
			/* tears down providers + Y.Doc */
		},
		destroyAll() {
			/* tears down everything */
		},
	};
}

// packages/filesystem/src/content-ops.ts
export class ContentOps {
	private store: ContentDocStore;
	constructor(providers?: ProviderFactory[]) {
		this.store = createContentDocStore(providers);
	}
	async read(fileId) {
		/* ensure → timeline → readAsString */
	}
	async write(fileId, data) {
		/* ensure → timeline → transact */
	}
	async append(fileId, data) {
		/* ensure → timeline → insert */
	}
	// ...
}
```

`YjsFileSystem` composes `ContentOps` and `FileTree`:

```typescript
// packages/filesystem/src/yjs-file-system.ts
export class YjsFileSystem implements IFileSystem {
	constructor(
		tree: FileTree,
		readonly content: ContentOps,
		cwd = '/',
	) {}
	static create(filesTable, cwd?, options?) {
		const tree = new FileTree(filesTable);
		const content = new ContentOps(options?.providers);
		return new YjsFileSystem(tree, content, cwd);
	}
}
```

The fs-explorer app creates its own workspace and filesystem:

```typescript
// apps/fs-explorer/src/lib/fs/fs-state.svelte.ts
const ws = createWorkspace({
	id: 'fs-explorer',
	tables: { files: filesTable },
});
const fs = YjsFileSystem.create(ws.tables.files);
// Later: fs.content.read(id), fs.content.write(id, data)
```

This creates problems:

1. **Duplicate doc management**: `createContentDocStore` duplicates what `createDocumentBinding` now does — Y.Doc creation, provider lifecycle, cleanup on shutdown. The two systems don't share state.
2. **No extension hooks**: `ContentOps` takes raw `ProviderFactory[]` — there's no way for workspace extensions (persistence, sync) to participate in content doc lifecycle via `onDocumentOpen`.
3. **No automatic updatedAt**: `ContentOps` doesn't bump `updatedAt` when content changes. The caller must do it manually (and the `filesTable` now has `.withDocument('content', { guid: 'id', updatedAt: 'updatedAt' })` which would do this automatically).
4. **No row-deletion cleanup**: Deleting a file row doesn't automatically destroy its content doc. `YjsFileSystem.rm()` manually calls `this.content.destroy(id)` — but only in that one code path.

### Desired State

```typescript
// fs-explorer creates workspace with extensions
const ws = createWorkspace({
	id: 'fs-explorer',
	tables: { files: filesTable },
}).withExtension('persistence', indexeddbPersistence);

// Content docs are managed by the document binding — automatically
const { content } = ws.tables.files.docs;
await content.read(fileId); // opens doc, returns text
await content.write(fileId, 'hello'); // opens doc, writes, auto-bumps updatedAt
// Row deletion → automatic doc cleanup via binding observer
```

No `ContentOps` class. No `createContentDocStore`. No manual provider wiring. Extensions participate via `onDocumentOpen`.

## Research Findings

### ContentOps Method Mapping

Every `ContentOps` method maps to either the document binding directly or a thin wrapper:

| ContentOps Method      | Document Binding Equivalent   | Notes                                                                                            |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `read(fileId)`         | `content.read(fileId)`        | Binding reads `getText('content')`. ContentOps reads via timeline. See Open Question 1.          |
| `readBuffer(fileId)`   | No direct equivalent          | Binary content needs a thin wrapper over `content.open(fileId)`                                  |
| `write(fileId, data)`  | `content.write(fileId, text)` | Binding writes to `getText('content')`. ContentOps handles text/binary/sheet modes via timeline. |
| `append(fileId, data)` | No direct equivalent          | Needs a thin wrapper over `content.open(fileId)`                                                 |
| `destroy(fileId)`      | `content.destroy(fileId)`     | Direct mapping                                                                                   |
| `destroyAll()`         | `content.destroyAll()`        | Direct mapping                                                                                   |

**Key finding**: `ContentOps` uses a "timeline" abstraction (`createTimeline(ydoc)`) that supports multiple content modes (text, richtext, binary, sheet). The document binding's `read()`/`write()` only handle plain text via `getText('content')`. Domain-specific operations (binary, sheet, timeline) need to go through `content.open()` and work with the Y.Doc directly.

### Consumer Analysis

| Consumer                             | Uses                                                         | Migration Path                                                     |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `YjsFileSystem`                      | `ContentOps.read/readBuffer/write/append/destroy/destroyAll` | Replace `ContentOps` with document binding + thin timeline wrapper |
| `fs-explorer` (fs-state.svelte.ts)   | `fs.content.read(id)`, `fs.content.write(id, data)`          | Use `ws.tables.files.docs.content.read/write` directly             |
| `fs-explorer` (ContentEditor.svelte) | Indirectly via fsState actions                               | No change needed — actions layer abstracts it                      |

### createContentDocStore vs createDocumentBinding

| Feature               | createContentDocStore  | createDocumentBinding     |
| --------------------- | ---------------------- | ------------------------- |
| Y.Doc creation        | ✅                     | ✅                        |
| Provider lifecycle    | ✅ (ProviderFactory[]) | ✅ (onDocumentOpen hooks) |
| Idempotent open       | ✅ (ensure)            | ✅ (open)                 |
| updatedAt auto-bump   | ❌                     | ✅                        |
| Row deletion cleanup  | ❌                     | ✅                        |
| Extension integration | ❌                     | ✅                        |
| clearData/purge       | ❌                     | ✅                        |
| gc: false             | ✅                     | ✅                        |

`createDocumentBinding` is a strict superset.

## Design Decisions

| Decision                         | Choice                                                                             | Rationale                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Keep timeline wrapper or not     | Keep as utility function                                                           | Timeline is filesystem-specific (text/binary/sheet modes). The document binding shouldn't know about it. |
| Where to put timeline wrapper    | `packages/filesystem/src/content-helpers.ts`                                       | Co-located with filesystem, uses `content.open()` internally                                             |
| ContentOps class fate            | Delete                                                                             | All methods either map to binding directly or to thin helpers                                            |
| createContentDocStore fate       | Delete                                                                             | Fully replaced by createDocumentBinding                                                                  |
| YjsFileSystem.create() signature | Remove `options.providers` param                                                   | Providers come from workspace extensions now, not manual wiring                                          |
| Migration strategy               | Phase 1 refactor ContentOps → Phase 2 update fs-explorer → Phase 3 delete old code | Incremental, each phase independently shippable                                                          |

## Architecture

### Before

```
┌──────────────────────────────────────────────────┐
│  fs-explorer (app)                                │
│    createWorkspace({ tables: { files } })         │
│    YjsFileSystem.create(ws.tables.files)          │
│      └── ContentOps                               │
│            └── createContentDocStore(providers?)   │
│                  └── Map<FileId, DocEntry>         │
│                        └── Y.Doc + Lifecycle[]     │
└──────────────────────────────────────────────────┘
```

### After

```
┌──────────────────────────────────────────────────┐
│  fs-explorer (app)                                │
│    createWorkspace({ tables: { files } })         │
│      .withExtension('persistence', ...)           │
│                                                   │
│    ws.tables.files.docs.content  ← auto-wired     │
│      └── createDocumentBinding()                  │
│            └── Map<guid, DocEntry>                │
│                  └── Y.Doc + DocumentLifecycle[]  │
│                                                   │
│    YjsFileSystem(tree, ws.tables.files.docs)      │
│      └── uses binding for content I/O             │
│      └── timeline helpers for binary/sheet modes  │
└──────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Refactor ContentOps → Document Binding

- [x] **1.1** Create `packages/filesystem/src/content-helpers.ts` with thin wrappers that use `DocumentBinding.open()` + timeline for mode-specific operations (`readBuffer`, `append`, sheet writes)
- [x] **1.2** Update `YjsFileSystem` constructor to accept `DocumentBinding` instead of `ContentOps`
- [x] **1.3** Update `YjsFileSystem.create()` — accept document binding, remove `options.providers` parameter
- [x] **1.4** Remove manual `this.content.destroy(id)` calls in `YjsFileSystem.rm()` — the binding's table observer handles this automatically
- [x] **1.5** Update `YjsFileSystem.destroy()` — no longer needs to call `content.destroyAll()` (workspace destroy cascades)
- [x] **1.6** Verify all existing filesystem tests pass with the new wiring
- [x] **1.7** Add test verifying that row deletion triggers automatic content doc cleanup (no manual destroy needed)

### Phase 2: Update fs-explorer App

- [x] **2.1** Update `fs-state.svelte.ts` to wire workspace with extensions (IndexedDB persistence for both workspace Y.Doc and content docs via `onDocumentOpen`)
- [x] **2.2** Pass `ws.tables.files.docs.content` to `YjsFileSystem` constructor instead of creating `ContentOps` — handled automatically by `createWorkspace()` which wires document bindings for tables with `.withDocument()` declarations
- [x] **2.3** Update `readContent`/`writeContent` actions to use document binding directly (`ws.tables.files.docs.content.read/write`) — simpler path for the UI's text-only editor, while `YjsFileSystem.content` (ContentHelpers with timeline) remains available for full filesystem operations
- [x] **2.4** Verify fs-explorer builds and renders correctly

### Phase 3: Delete Standalone Content Doc Store

- [x] **3.1** Delete `packages/filesystem/src/content-doc-store.ts`
- [x] **3.2** Delete `packages/filesystem/src/content-doc-store.test.ts`
- [x] **3.3** Delete `packages/filesystem/src/content-ops.ts`
- [x] **3.4** Delete `packages/filesystem/src/content-ops.test.ts`
- [x] **3.5** Remove `ContentDocStore` type from `packages/filesystem/src/types.ts`
- [x] **3.6** Remove exports from `packages/filesystem/src/index.ts`: `createContentDocStore`, `ContentOps`, `ContentDocStore`
- [x] **3.7** Search for any remaining imports of deleted modules across the monorepo
- [x] **3.8** Run full typecheck + tests across affected packages

## Edge Cases

### Timeline Mode Switching

1. File has text content, user writes binary data
2. `ContentOps.write()` currently handles this via timeline's `pushBinary()`
3. The content helper wrapper must preserve this behavior — it can't just use `binding.write()` which is text-only

### Sheet Content

1. CSV imports write to `Y.Map<Y.Map<string>>` column/row structures
2. This is filesystem-specific and uses `parseSheetFromCsv`
3. Content helpers must expose a `writeSheet()` path that opens the doc and uses timeline

### Concurrent Content Access

1. `binding.open()` is idempotent — same GUID returns same Y.Doc
2. This matches `createContentDocStore.ensure()` behavior
3. No change in concurrent access semantics

### Provider Migration

1. `ContentOps` takes `ProviderFactory[]` — a dynamic API type (`{ ydoc } => Lifecycle`)
2. Document binding takes `onDocumentOpen` hooks — a static API type (`DocumentContext => DocumentLifecycle | void`)
3. Existing provider factories (if any are passed to `YjsFileSystem.create()`) need to be adapted or replaced with `onDocumentOpen` implementations on extensions

## Open Questions

1. **Timeline abstraction fate**: The timeline system (`createTimeline`) handles multi-mode content (text → binary → sheet transitions with history). Should the document binding's `read()`/`write()` be aware of timelines, or should this remain a filesystem-specific layer?
   - **Recommendation**: Keep timeline as filesystem-specific. The document binding's `read()`/`write()` are intentionally minimal (plain text via `getText('content')`). Filesystem adds domain logic on top via `content.open()`.

2. **Binary content support**: The document binding's `read()`/`write()` only handle text. Should we add `readBuffer()`/`writeBuffer()` to `DocumentBinding`?
   - **Recommendation**: No. Binary content is a filesystem concern. Use `binding.open()` and work with the Y.Doc directly. Keeps the binding API generic.

3. **fs-explorer provider wiring**: Currently fs-explorer creates a bare workspace with no extensions. When migrating, what extension should handle content doc persistence?
   - **Recommendation**: Add IndexedDB persistence extension that implements `onDocumentOpen`. This is the natural fit for a browser-only app.

## Success Criteria

- [x] `ContentOps` class and `createContentDocStore` are fully deleted
- [x] `YjsFileSystem` uses document binding for all content operations
- [x] `fs-explorer` uses workspace extensions for content doc persistence (IndexedDB via `y-indexeddb`, with `onDocumentOpen` for per-file content docs)
- [x] Row deletion automatically cleans up content docs (no manual `destroy()` calls)
- [x] `updatedAt` is automatically bumped on content changes (no manual bookkeeping)
- [x] All filesystem tests pass (208 pass)
- [x] All epicenter tests pass
- [ ] Typecheck passes on both packages (pre-existing type errors in `table-helper.test.ts` related to `TableDefinitionWithDocBuilder` — not caused by this migration)

## Review

### Summary of Changes

**Phase 1** (filesystem package refactor):

- Created `content-helpers.ts` — thin wrappers around `DocumentBinding.open()` + timeline for mode-aware content I/O (binary, sheet, text append)
- Refactored `YjsFileSystem` to accept `FilesTableWithDocs` instead of `ContentOps` — the document binding is accessed via `filesTable.docs.content`
- Removed manual `content.destroy()` calls in `rm()` — the binding's table observer handles cleanup automatically
- Simplified `destroy()` — content doc cleanup cascades through workspace destroy

**Phase 2** (fs-explorer app update):

- Added `y-indexeddb` dependency and wired `IndexeddbPersistence` as a workspace extension with `onDocumentOpen` — persists both the workspace Y.Doc and per-file content docs to browser IndexedDB
- Simplified `readContent`/`writeContent` actions to use `ws.tables.files.docs.content.read/write` directly instead of routing through `YjsFileSystem.content`. The binding's plain-text read/write is sufficient for the textarea editor; full timeline support remains available through `fs.content` for filesystem operations

**Phase 3** (cleanup):

- Deleted `content-ops.ts`, `content-doc-store.ts`, and their tests
- Removed `ContentDocStore` type and stale exports from `index.ts`

### Design Decisions Made During Implementation

1. **Timeline kept as filesystem-specific**: The document binding's `read()`/`write()` remain minimal (plain text via `getText('content')`). The filesystem's `ContentHelpers` wraps the binding with timeline for mode-aware operations. This keeps the binding API generic.

2. **Two content access paths**: `ws.tables.files.docs.content` (binding) for simple text I/O, and `fs.content` (ContentHelpers) for full mode-aware operations. The UI uses the binding directly; filesystem operations use ContentHelpers.

3. **Persistence extension inline**: The IndexedDB extension is defined inline in `fs-state.svelte.ts` rather than imported, because it needs `onDocumentOpen` which the existing `indexeddbPersistence` from `@epicenter/workspace/extensions/sync/web` doesn't provide.

### Known Issues

- Pre-existing type errors in `packages/epicenter/src/static/table-helper.test.ts` — `TableDefinitionWithDocBuilder` is not assignable to `TableDefinition`. These errors are unrelated to this migration (the test file was not modified on this branch).

## References

- `specs/20260217T094400-table-level-document-api.md` — Parent specification
- `packages/filesystem/src/content-helpers.ts` — ContentHelpers (new, wraps binding with timeline)
- `packages/filesystem/src/yjs-file-system.ts` — YjsFileSystem (refactored)
- `packages/filesystem/src/timeline-helpers.ts` — Timeline abstraction (preserved)
- `packages/epicenter/src/static/create-document-binding.ts` — DocumentBinding implementation
- `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts` — App state (updated with persistence extension)
