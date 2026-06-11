# Document Handle API

> **Note**: The `.docs` access pattern described here was replaced by `client.documents`: see specs/20260221T204200-documents-top-level-namespace.md

**Date:** 2026-02-20
**Status:** Implemented
**Author:** AI-assisted
**Scope:** `DocumentBinding`, `DocumentHandle`, `createDocumentBinding`, `types.ts`

## Overview

Redesign the `DocumentBinding` type to return a `DocumentHandle` from `open()`, making per-document operations (read, write, exports) properties/methods on the handle instead of top-level binding methods that all take an `input` parameter. Rename `destroy`/`destroyAll` to `close`/`closeAll` to reflect that data is preserved.

## Motivation

### Current State

All 8 methods live at the same level on `DocumentBinding`, serving 4 different concerns:

```typescript
type DocumentBinding<TRow extends BaseRow> = {
	// Content access
	open(input: TRow | string): Promise<Y.Doc>;
	read(input: TRow | string): Promise<string>;
	write(input: TRow | string, text: string): Promise<void>;

	// Resource lifecycle
	destroy(input: TRow | string): Promise<void>;
	destroyAll(): Promise<void>;

	// Extension introspection
	getExports(
		input: TRow | string,
	): Record<string, Record<string, unknown>> | undefined;

	// Column extraction
	guidOf(row: TRow): string;
	updatedAtOf(row: TRow): number;
};
```

Calling code repeats the same `input` parameter across every method:

```typescript
// clearData-before-delete pattern
const exports = binding.getExports(guid);
await exports?.persistence?.clearData?.();
await binding.destroy(guid);
```

This creates problems:

1. **Flat namespace mixes concerns**: Content access, lifecycle, extension introspection, and column extraction all sit at the same level with no grouping. A new user sees 8 methods and has no hierarchy to orient around.
2. **`getExports` as a function is unnatural**: Exports are a property of an open document, but the current API forces you to call a function with a lookup key. It reads like a getter pretending to be a method.
3. **`destroy` implies data loss**: The method frees memory and disconnects providers but preserves persisted data. "Destroy" suggests permanent deletion, which is misleading.
4. **`read`/`write` are async for no good reason**: They call `open()` internally, then do a synchronous Y.Doc text operation. The async-ness is hidden plumbing, not a real requirement. Callers can't tell that `read(id)` secretly opens a doc if it isn't already open.
5. **`guidOf`/`updatedAtOf` are barely used**: Outside of tests, nobody calls these. They're column extractors that belong closer to the binding's metadata, not as top-level methods alongside `open`.

### Desired State

`open()` returns a `DocumentHandle` scoped to one document. Per-document operations become methods/properties on the handle. The binding itself is just an opener and global lifecycle manager.

```typescript
const handle = await binding.open(id);

// Content: synchronous, doc is already open
const text = handle.read();
handle.write('new content');

// Exports: natural property, not a lookup function
await handle.exports.persistence?.clearData?.();

// Lifecycle: "close" not "destroy"
await binding.close(id);
```

## Design

### New Types

````typescript
/**
 * A handle to an open content Y.Doc, returned by `binding.open()`.
 *
 * All operations are scoped to this specific document. Content methods
 * (read, write) are synchronous because the Y.Doc is already open.
 * Exports are a property, not a function, because they belong to this doc.
 */
type DocumentHandle = {
	/** The raw Y.Doc: escape hatch for custom operations (timelines, binary, sheets). */
	ydoc: Y.Doc;

	/** Read the document's text content (from `ydoc.getText('content')`). */
	read(): string;

	/** Replace the document's text content. */
	write(text: string): void;

	/**
	 * Per-doc extension exports, keyed by extension name.
	 *
	 * Each key corresponds to a document extension registered via
	 * `withDocumentExtension()`. The value is that extension's `exports` object.
	 *
	 * @example
	 * ```typescript
	 * const handle = await binding.open(guid);
	 * await handle.exports.persistence?.clearData?.();
	 * ```
	 */
	exports: Record<string, Record<string, unknown>>;
};

/**
 * Runtime binding between a table and its associated content Y.Docs.
 *
 * Manages Y.Doc creation, provider lifecycle, `updatedAt` auto-bumping,
 * and cleanup on row deletion. Most users access this via
 * `client.tables.files.docs.content`.
 *
 * @typeParam TRow - The row type of the bound table
 *
 * @example
 * ```typescript
 * const handle = await binding.open(row);
 * handle.ydoc.getText('body').insert(0, 'hello');
 * // updatedAt on the row is bumped automatically
 *
 * const text = handle.read();
 * handle.write('new content');
 * await binding.close(row);
 * ```
 */
type DocumentBinding<TRow extends BaseRow> = {
	/**
	 * Open a content Y.Doc for a row.
	 *
	 * Creates the Y.Doc if it doesn't exist, wires up providers, and attaches
	 * the updatedAt observer. Idempotent: calling open() twice for the same
	 * row returns the same handle (same Y.Doc).
	 *
	 * @param input - A row (extracts GUID from the bound column) or a GUID string
	 */
	open(input: TRow | string): Promise<DocumentHandle>;

	/**
	 * Close a document: free memory, disconnect providers.
	 * Persisted data is NOT deleted. The doc can be re-opened later.
	 *
	 * @param input - A row or GUID string
	 */
	close(input: TRow | string): Promise<void>;

	/**
	 * Close all open documents. Called automatically by workspace destroy().
	 */
	closeAll(): Promise<void>;
};
````

### What Changes

| Aspect               | Before                  | After                                        |
| -------------------- | ----------------------- | -------------------------------------------- |
| `open()` return type | `Promise<Y.Doc>`        | `Promise<DocumentHandle>`                    |
| `read(input)`        | Async method on binding | Sync method on handle (`handle.read()`)      |
| `write(input, text)` | Async method on binding | Sync method on handle (`handle.write(text)`) |
| `getExports(input)`  | Function on binding     | Property on handle (`handle.exports`)        |
| `destroy(input)`     | Method name             | Renamed to `close(input)`                    |
| `destroyAll()`       | Method name             | Renamed to `closeAll()`                      |
| `updatedAtOf(row)`   | Method on binding       | Removed (unused outside tests)               |

### What Stays the Same

- `open()` is still idempotent (same handle for same GUID)
- `open()` still accepts `TRow | string`
- The binding still auto-bumps `updatedAt` on content changes
- The binding still auto-cleans docs when rows are deleted
- `guidOf(row)` was removed (column extraction is no longer exposed on the binding)
- `createDocumentBinding()` config is unchanged
- `withDocument()` declaration API is unchanged
- `withDocumentExtension()` is unchanged
- The `docs` namespace on table helpers is unchanged (`tables.files.docs.content`)

## Calling Code Comparison

### content-helpers.ts (most common pattern)

```typescript
// BEFORE
const ydoc = await binding.open(fileId);
const tl = createTimeline(ydoc);

// AFTER
const handle = await binding.open(fileId);
const tl = createTimeline(handle.ydoc);
```

### fs-state.svelte.ts (UI layer)

```typescript
// BEFORE
const text = await ws.tables.files.docs.content.read(id);
await ws.tables.files.docs.content.write(id, data);

// AFTER
const handle = await ws.tables.files.docs.content.open(id);
const text = handle.read();
handle.write(data);
```

Note: the UI layer already needs the handle open to display content. The two-step pattern (open, then read/write) matches the actual UI lifecycle: open when the user navigates to a file, read/write while editing, close when they navigate away.

### clearData-before-delete

```typescript
// BEFORE
const exports = binding.getExports(guid);
await exports?.persistence?.clearData?.();
await binding.destroy(guid);

// AFTER
const handle = await binding.open(guid);
await handle.exports.persistence?.clearData?.();
await binding.close(guid);
```

`exports` as a property is more natural: "this document's exports" rather than "look up exports for this ID."

### create-workspace.ts (workspace cleanup)

```typescript
// BEFORE
documentBindingCleanups.push(() => binding.destroyAll());

// AFTER
documentBindingCleanups.push(() => binding.closeAll());
```

### create-document-binding.ts (internal implementation)

```typescript
// BEFORE: read() and write() call open() internally
async read(input: TRow | string): Promise<string> {
  const doc = await binding.open(input);
  return doc.getText('content').toString();
},

async write(input: TRow | string, text: string): Promise<void> {
  const doc = await binding.open(input);
  const ytext = doc.getText('content');
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, text);
  });
},

// AFTER: open() returns a handle, read/write are on the handle
async open(input: TRow | string): Promise<DocumentHandle> {
  const guid = resolveGuid(input);
  const existing = docs.get(guid);
  if (existing) {
    const ydoc = await existing.whenReady;
    return makeHandle(ydoc, existing.exports);
  }
  // ... create Y.Doc, wire extensions, cache entry ...
  const ydoc = await whenReady;
  return makeHandle(ydoc, docExports);
},
```

Where `makeHandle` is a small factory:

```typescript
function makeHandle(
	ydoc: Y.Doc,
	exports: Record<string, Record<string, unknown>>,
): DocumentHandle {
	return {
		ydoc,
		exports,
		read() {
			return ydoc.getText('content').toString();
		},
		write(text: string) {
			const ytext = ydoc.getText('content');
			ydoc.transact(() => {
				ytext.delete(0, ytext.length);
				ytext.insert(0, text);
			});
		},
	};
}
```

## Simplifications

### 1. Binding surface area shrinks from 8 methods to 3

Before: `open`, `read`, `write`, `destroy`, `destroyAll`, `getExports`, `guidOf`, `updatedAtOf`
After: `open`, `close`, `closeAll`

The binding becomes single-responsibility: manage Y.Doc lifecycle. Content operations and extension access move to the handle.

### 2. `read`/`write` become synchronous

No more hidden `open()` calls inside `read()`/`write()`. The caller explicitly opens the doc first, then works with it synchronously. This is more honest about what's happening and removes a class of "why is this async?" confusion.

### 3. `getExports` disappears as a concept

It's just `handle.exports`: a property on the thing you already have. No separate lookup function, no `undefined` return for "not open" (you have a handle, so it's open).

### 4. `updatedAtOf` is removed

Zero usage outside tests. If needed, consumers can read `row[updatedAtKey]` directly. One less method to document and maintain.

### 5. Naming clarity: `close` vs `destroy`

"Close" correctly communicates "free resources, keep data." "Destroy" was misleading. It suggested permanent deletion, which is not what it does. This aligns with how filesystems (close a file handle), databases (close a connection), and editors (close a tab) use the term.

### 6. Handle pattern enables future extensions

If we later want to add `handle.isReady`, `handle.guid`, or `handle.observe()`, they have a natural home. The flat binding had no good place for per-document properties.

## Edge Cases

### Idempotent open returns the same handle

Calling `open()` twice for the same GUID should return handles backed by the same Y.Doc. Whether it returns the exact same handle object or a new handle wrapping the same Y.Doc is an implementation detail: both are correct since handles are lightweight wrappers.

### Handle used after close

If a consumer holds a handle and someone else calls `binding.close(guid)`, the handle's `ydoc` is destroyed. Calling `handle.read()` on a destroyed Y.Doc is undefined behavior in Yjs. This is the same risk as today (holding a Y.Doc reference after `destroy()`). No change needed.

### content-helpers.ts only uses `ydoc`

`createContentHelpers` calls `binding.open(fileId)` and only uses the returned Y.Doc for timeline operations. After the change it accesses `handle.ydoc`. The `read()`/`write()` methods on the handle won't be used by content-helpers since it has its own mode-aware content logic. This is fine. The handle provides both the convenience layer and the escape hatch.

## Implementation Plan

### Phase 1: Types and handle factory

- [x] **1.1** Add `DocumentHandle` type to `types.ts`
- [x] **1.2** Update `DocumentBinding` type: change `open()` return type, rename `destroy`→`close`, `destroyAll`→`closeAll`, remove `read`, `write`, `getExports`, `updatedAtOf`
- [x] **1.3** Update `DocsPropertyOf` if needed (no change needed: it maps to `DocumentBinding`)

### Phase 2: Implementation

- [x] **2.1** Add `makeHandle()` factory inside `create-document-binding.ts`
- [x] **2.2** Update `open()` to return `DocumentHandle` instead of `Y.Doc`
- [x] **2.3** Remove `read()`, `write()`, `getExports()`, `updatedAtOf()` from the binding implementation
- [x] **2.4** Rename `destroy()` → `close()`, `destroyAll()` → `closeAll()`

### Phase 3: Consumer updates

- [x] **3.1** `content-helpers.ts`: change `binding.open(fileId)` usage to `(await binding.open(fileId)).ydoc`
- [x] **3.2** `fs-state.svelte.ts`: change `binding.read(id)` / `binding.write(id, data)` to open-then-handle pattern
- [x] **3.3** `yjs-file-system.ts`: no change needed (`FilesTableWithDocs` references `DocumentBinding` which updated automatically)
- [x] **3.4** `create-workspace.ts`: rename `binding.destroyAll()` → `binding.closeAll()`

### Phase 4: Tests

- [x] **4.1** Update `create-document-binding.test.ts`: adapt all tests to handle pattern
- [x] **4.2** Update `create-workspace.test.ts`: adapt doc binding tests
- [x] **4.3** Update `yjs-file-system.test.ts`: adapt binding usage in tests
- [x] **4.4** `define-table.test.ts`: unaffected (tests definitions, not runtime)
- [x] **4.5** Run full test suite: 1118 pass, 0 fail, 2 skip

## Open Questions

1. **Should `open()` always return a fresh handle object, or cache and return the same handle?**
   - Fresh handle: simpler implementation, no stale reference risk after close
   - Cached handle: `handle1 === handle2` identity check works, slightly less allocation
   - **Recommendation**: Fresh handle wrapping the cached Y.Doc. Handles are cheap (4 properties). The Y.Doc underneath is the expensive shared resource.

2. **Should `handle.read()`/`handle.write()` always use `getText('content')`, or accept a key?**
   - Current `read()`/`write()` hardcode `'content'` as the Y.Text key
   - Some future use cases might want different keys
   - **Recommendation**: Keep hardcoded `'content'` for now. The escape hatch is `handle.ydoc.getText('whatever')`. If a pattern emerges, add `handle.getText(key)` later.

3. **Should the `exports` type on `DocumentHandle` be more specific?**
   - Currently `Record<string, Record<string, unknown>>`: very loose
   - Could be typed per-extension if document extensions declared their export shapes
   - **Recommendation**: Keep loose for now. Typed document extension exports is a separate feature that doesn't block this refactor.

## Success Criteria

- [x] `DocumentBinding` has 3 methods: `open`, `close`, `closeAll`
- [x] `DocumentHandle` has `ydoc`, `read()`, `write()`, `exports`
- [x] All existing tests pass (adapted to new API): 1118 pass, 0 fail
- [x] No `destroy` / `destroyAll` / `getExports` / `updatedAtOf` references remain on `DocumentBinding`
- [x] `read()` and `write()` are synchronous on the handle
- [x] `exports` is a property, not a function

## Review

### Changes Made

**Types (`types.ts`)**:

- Added `DocumentHandle` type with `ydoc`, `read()`, `write()`, `exports`
- Replaced 8-method `DocumentBinding` with 3-method version: `open` (returns `DocumentHandle`), `close`, `closeAll`
- Exported `DocumentHandle` from `index.ts`

**Implementation (`create-document-binding.ts`)**:

- Added `makeHandle()` factory: lightweight wrapper around Y.Doc + exports
- `open()` now resolves to `makeHandle(contentYdoc, docExports)` instead of raw Y.Doc
- Removed `read()`, `write()`, `getExports()`, `updatedAtOf()` implementations
- Renamed `destroy()` → `close()`, `destroyAll()` → `closeAll()`
- Updated default `onRowDeleted` handler to call `close()` instead of `destroy()`

**Consumers**:

- `create-workspace.ts`: `binding.destroyAll()` → `binding.closeAll()`
- `content-helpers.ts`: `binding.open(fileId)` → `handle.ydoc` for timeline operations
- `fs-state.svelte.ts`: `binding.read(id)` / `binding.write(id, data)` → open-then-handle pattern
- `yjs-file-system.ts`: No changes needed: `FilesTableWithDocs` type updated automatically via `DocumentBinding`

**Tests**:

- `create-document-binding.test.ts`: All tests adapted: `doc` → `handle.ydoc`, `binding.read/write` → `handle.read/write`, `destroy` → `close`, `destroyAll` → `closeAll`, `getExports` → `handle.exports`, removed `updatedAtOf` test
- `create-workspace.test.ts`: Updated `DocumentBindingLike` helper type, updated method existence assertions
- `yjs-file-system.test.ts`: Updated 3 callsites that used `binding.open()` result as raw Y.Doc

### Open Questions Resolution

1. **Fresh vs cached handle**: Implemented as **fresh handle wrapping cached Y.Doc**, per recommendation. Each `open()` call returns a new handle object but the underlying Y.Doc is shared.
2. **`getText('content')` hardcoded**: Kept hardcoded per recommendation. The escape hatch `handle.ydoc.getText('whatever')` is available.
3. **Loose exports type**: Kept `Record<string, Record<string, unknown>>` per recommendation.

### Test Results

- **1118 pass**, 0 fail, 2 skip (pre-existing skips unrelated to this change)

## Related Specs

- [Extension Handle Passthrough](./20260220T200000-extension-handle-passthrough.md): Changes how extensions are stored in `client.extensions[key]` from flat exports to `{ exports, lifecycle }` wrappers. **Overlapping file**: `create-document-binding.ts`: this spec changed the binding surface (`open→DocumentHandle`, `destroy→close`); that spec changes how document extension results are wrapped in the extension loop. **No conflicts**: `DocumentHandle.exports` (introduced by this spec) stays flat. Only `DocumentContext.extensions` (factory context) gets the `ExtensionHandle` wrapper.

## References

- `packages/epicenter/src/static/types.ts`: Type definitions (primary change)
- `packages/epicenter/src/static/create-document-binding.ts`: Runtime implementation
- `packages/epicenter/src/static/create-workspace.ts`: Wiring (destroyAll → closeAll)
- `packages/filesystem/src/content-helpers.ts`: Primary consumer (open → ydoc)
- `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`: UI consumer (read/write)
- `packages/filesystem/src/yjs-file-system.ts`: Type reference (FilesTableWithDocs)
