# Document Extension API

**Date**: 2026-02-19
**Status**: Draft
**Author**: AI-assisted

## Overview

Separate workspace-level extensions from document-level extensions into distinct API methods with tag-based targeting. Currently, `withExtension` bundles both workspace Y.Doc lifecycle and per-document Y.Doc lifecycle (via `onDocumentOpen`) in a single factory return value. This redesign splits them into `withExtension` (workspace only) and `withDocumentExtension` (content docs only), with an optional `{ tags }` parameter for scoped targeting.

## Motivation

### Current State

In `create-workspace.ts`, the `withExtension` method handles both workspace and document scopes by accumulating `onDocumentOpen` hooks in a shared array.

```typescript
// packages/epicenter/src/static/create-workspace.ts

// 1. Hooks are accumulated in a shared array
const documentOpenHooks: ((
  context: DocumentContext,
) => DocumentLifecycle | void)[] = [];

// 2. Document bindings reference this array by closure
const binding = createDocumentBinding({
  // ...
  onDocumentOpen: documentOpenHooks,
  // ...
});

// 3. withExtension collects the hooks
withExtension(key, factory) {
  const result = factory(client);
  // ...
  if (result.onDocumentOpen) {
    documentOpenHooks.push(result.onDocumentOpen);
  }
  // ...
}
```

The `fs-explorer` persistence extension demonstrates how these concerns are mixed in a single factory:

```typescript
// apps/fs-explorer/src/lib/fs/fs-state.svelte.ts

const ws = createWorkspace({
	id: 'fs-explorer',
	tables: { files: filesTable },
}).withExtension('persistence', ({ ydoc }) => {
	// Workspace persistence
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	return {
		exports: { clearData: () => idb.clearData() },
		lifecycle: {
			whenReady: idb.whenSynced,
			destroy: () => idb.destroy(),
		},
		// Document persistence (nested inside workspace extension)
		onDocumentOpen({ ydoc: contentDoc }) {
			const contentIdb = new IndexeddbPersistence(contentDoc.guid, contentDoc);
			return {
				whenReady: contentIdb.whenSynced,
				destroy: () => contentIdb.destroy(),
				clearData: () => contentIdb.clearData(),
			};
		},
	};
});
```

This creates several problems:

1. **Mixed concerns**: One extension factory handles two different Y.Doc scopes (workspace + content docs). The persistence extension in fs-explorer creates `IndexeddbPersistence` for the workspace doc and for each content doc in the same factory.
2. **Routing logic for divergent needs**: If different tables need different document extension behavior (e.g., images don't sync, notes need revision history), extensions must branch on `binding.tableName` inside `onDocumentOpen`. This turns extensions into routing god-objects.
3. **No targeting system**: There's no way to declaratively say "this document type gets this set of extensions." All document extensions fire for all documents, and opt-out is imperative branching.

### Desired State

Workspace extensions and document extensions are clearly separated. Document extensions use an optional `{ tags }` parameter to target specific document types.

```typescript
const workspace = createWorkspace({ id: 'my-app', tables: { notes, images } })
	// Workspace scope
	.withExtension('persistence', ({ ydoc }) => {
		const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
		return {
			lifecycle: { whenReady: idb.whenSynced, destroy: () => idb.destroy() },
		};
	})
	// Document scope: targeted via tags
	.withDocumentExtension(
		'persistence',
		({ ydoc }) => {
			const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
			return { whenReady: idb.whenSynced, destroy: () => idb.destroy() };
		},
		{ tags: ['persistent'] },
	);
```

## Design Decisions

| Decision                                                | Choice                                                                               | Rationale                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate workspace from document extensions             | Two distinct methods: `withExtension` and `withDocumentExtension`                    | Each Y.Doc scope has its own lifecycle. Workspace extensions return `{ exports, lifecycle }`. Document extensions return `DocumentLifecycle`. Mixing them bundled unrelated concerns.                                                                                        |
| Document extensions use optional `{ tags }` for scoping | Third parameter options bag: `withDocumentExtension(key, factory, { tags })`         | Default is universal (fires for all docs). Tagging is opt-in via options. No transient builder types, no postfix methods. The options bag is extensible for future fields (priority, table filtering) and gives clean TypeScript inference with a single method signature.   |
| Include-only tag matching (no `except`)                 | Extensions list which tags they target; no exclusion mechanism                       | Simpler mental model: list what you want, or omit tags for universal. The "default-on except X" pattern is handled by explicitly tagging all document types that participate. If `except` becomes a real pain point, it's a backward-compatible addition to the options bag. |
| Tags declared inline on `withDocument`                  | `withDocument('content', { guid, updatedAt, tags: ['persistent', 'synced'] })`       | Tags are a declaration of identity ("this document IS persistent and synced"), not extension targeting. Inline keeps all document binding config in one place.                                                                                                               |
| Documents support multiple tags                         | `tags?: TTags \| readonly TTags[]` with `const` type parameter for literal inference | A document can match multiple tags (like CSS classes). Extension matching uses set intersection: `{ tags: ['synced'] }` fires if doc tags contain `'synced'`. Multiple tags enable cross-cutting concerns (a doc can be both `persistent` and `synced`).                     |
| Tag values are type-inferred from table definitions     | `ExtractAllDocTags<TTableDefs>` utility type collects all tag literals               | Enables autocomplete and catches typos at compile time. All tags from all `withDocument()` calls across all tables form a union type.                                                                                                                                        |
| Keys required on document extensions                    | `withDocumentExtension(key, factory)` matches `withExtension(key, factory)`          | Consistent API shape. Keys enable debugging ("doc extension 'persistence' failed for doc X"), deduplication (prevents double-registration), and future export capabilities. Independent namespace from workspace extension keys.                                             |
| Workspace extension return type simplified              | `Extension` no longer includes `onDocumentOpen`                                      | `withExtension` factories return `{ exports?, lifecycle? }` only. The `onDocumentOpen` hook is removed. Document lifecycle is handled entirely by `withDocumentExtension`.                                                                                                   |
| Independent key namespaces                              | Workspace extension keys and document extension keys can collide without conflict    | Both can have a key called `'persistence'`. Internally stored separately. Logging can prefix (`workspace:persistence`, `doc:persistence`) if needed.                                                                                                                         |

## Architecture

The two-scope model separates the workspace Y.Doc from the many content Y.Docs.

```
┌─────────────────────────────────────────────────────────────┐
│  createWorkspace({ id, tables })                             │
│                                                              │
│  .withExtension(key, factory)                                │
│    → factory({ ydoc, tables, kv, awareness, extensions })    │
│    → returns { exports?, lifecycle? }                        │
│    → scope: WORKSPACE Y.Doc (one per workspace)              │
│                                                              │
│  .withDocumentExtension(key, factory, options?)               │
│    → factory({ ydoc, whenReady, binding })                   │
│    → returns DocumentLifecycle { whenReady?, destroy?, ... } │
│    → scope: CONTENT Y.Docs (N per table with .withDocument) │
│    → optional: { tags: ['persistent', 'synced'] }           │
│                                                              │
│  .withActions(factory)  ← terminal, same as before           │
└─────────────────────────────────────────────────────────────┘
```

The tag matching flow determines which extensions apply to a document when it's opened.

```
document.open(row) called
  ↓
Resolve document's tags (from withDocument config)
  ↓
For each registered document extension:
  ├─ No tags on extension → FIRE (universal)
  └─ Has tags → FIRE if doc tags and extension tags share ANY value
```

## API Reference

### `withDocumentExtension(key, factory, options?)`

Registers a document extension that fires when content Y.Docs are opened via a table's document binding.

Signature:

```typescript
withDocumentExtension<K extends string>(
  key: K,
  factory: (context: DocumentContext) => DocumentLifecycle | void,
  options?: { tags?: ExtractAllDocTags<TTableDefinitions>[] },
): WorkspaceClientBuilder<...>
```

If no `tags` option is provided, the extension is universal (fires for all content docs).

If `tags` is provided, the extension fires only for documents whose tags share at least one value with the extension's tags (set intersection).

### `DocumentContext`

The context received by the document extension factory.

```typescript
type DocumentContext = {
	ydoc: Y.Doc; // The content Y.Doc being opened
	whenReady: Promise<void>; // Resolves when all PRIOR document extensions are ready
	binding: {
		tableName: string; // Which table this doc belongs to
		documentName: string; // Which document binding name (e.g., 'content')
		tags: readonly string[]; // The document's tags (from withDocument config)
	};
};
```

### `DocumentLifecycle`

The lifecycle object returned by the document extension factory.

```typescript
type DocumentLifecycle = {
	whenReady?: Promise<unknown>; // Provider initialization
	destroy: () => MaybePromise<void>; // Teardown
	clearData?: () => MaybePromise<void>; // For purge operations
};
```

### Table-side tag declaration

Tags are declared within the `withDocument` configuration on the table.

```typescript
defineTable(schema)
	.withDocument('content', {
		guid: 'id',
		updatedAt: 'updatedAt',
		tags: ['persistent', 'synced'], // multiple tags
	})
	.withDocument('cover', {
		guid: 'coverId',
		updatedAt: 'coverUpdatedAt',
		tags: 'persistent', // single tag (sugar for ['persistent'])
	})
	.withDocument('preview', {
		guid: 'previewId',
		updatedAt: 'previewUpdatedAt', // no tags = only universal doc extensions
	});
```

### `DocBinding` type

Updated to include an optional `TTags` generic parameter.

```typescript
type DocBinding<
	TGuid extends string,
	TUpdatedAt extends string,
	TTags extends string = never,
> = {
	guid: TGuid;
	updatedAt: TUpdatedAt;
	tags?: TTags extends never ? undefined : readonly TTags[] | TTags;
};
```

### `ExtractAllDocTags` utility type

Collects all tag literal types from all table definitions into a union for type-safe autocomplete.

```typescript
/** Extract tags from a single DocBinding */
type ExtractDocTags<T> =
	T extends DocBinding<string, string, infer TTags> ? TTags : never;

/** Extract all tags across all tables' document bindings */
type ExtractAllDocTags<TTableDefs extends TableDefinitions> = {
	[K in keyof TTableDefs]: TTableDefs[K] extends { docs: infer TDocs }
		? TDocs extends Record<string, infer TBinding>
			? ExtractDocTags<TBinding>
			: never
		: never;
}[keyof TTableDefs];
```

Given tables with tags `['persistent', 'synced']`, `['persistent']`, and `['ephemeral']`, the extracted type is `'persistent' | 'synced' | 'ephemeral'`. This means `{ tags: ['sycned'] }` is a compile-time error (typo caught).

### TypeScript Generics

The builder accumulates document extension keys for deduplication.

```typescript
type WorkspaceClientBuilder<
  TId extends string,
  TTableDefinitions extends TableDefinitions,
  TKvDefinitions extends KvDefinitions,
  TAwarenessDefinitions extends AwarenessDefinitions,
  TExtensions extends Record<string, unknown> = Record<string, never>,
  TDocExtKeys extends string = never,
> = WorkspaceClient<...> & {
  withExtension<TKey extends string, TExports extends Record<string, unknown>>(
    key: TKey,
    factory: (context: ExtensionContext<...>) => Extension<TExports>,
  ): WorkspaceClientBuilder<..., TExtensions & Record<TKey, TExports>, TDocExtKeys>;

  withDocumentExtension<K extends string>(
    key: K,
    factory: (context: DocumentContext) => DocumentLifecycle | void,
    options?: { tags?: ExtractAllDocTags<TTableDefinitions>[] },
  ): WorkspaceClientBuilder<..., TExtensions, TDocExtKeys | K>;

  withActions<TActions extends Actions>(
    factory: (client: WorkspaceClient<...>) => TActions,
  ): WorkspaceClientWithActions<...>;
};
```

Each `.withDocumentExtension<K>(key, factory)` adds `K` to `TDocExtKeys`. Each `.withExtension<K>(key, factory)` adds `K` to `TExtensions`. Both accumulate independently.

### `withDocument` updated signature

The `withDocument` method on `defineTable` gains a `tags` parameter with `const` type inference.

```typescript
withDocument<
  TName extends string,
  TGuid extends StringKeysOf<TRow>,
  TUpdatedAt extends NumberKeysOf<TRow>,
  const TTags extends string,
>(
  name: TName,
  binding: { guid: TGuid; updatedAt: TUpdatedAt; tags?: TTags | readonly TTags[] },
): TableDefinitionWithDocBuilder<
  TVersions,
  TDocs & Record<TName, DocBinding<TGuid, TUpdatedAt, TTags>>
>;
```

The `const TTags` generic (TypeScript 5.0+) ensures literal type inference: `tags: 'synced'` infers `TTags = 'synced'`, not `TTags = string`.

## Complete Call-Site Example

A realistic example showing workspace and document extensions with tag-based targeting.

```typescript
// ── Table Definitions ──
const notes = defineTable(
  type({ id: 'string', title: 'string', updatedAt: 'number', _v: '1' }),
).withDocument('content', {
  guid: 'id',
  updatedAt: 'updatedAt',
  tags: ['persistent', 'synced'],
});

const images = defineTable(
  type({ id: 'string', thumbId: 'string', thumbUpdatedAt: 'number', _v: '1' }),
).withDocument('thumb', {
  guid: 'thumbId',
  updatedAt: 'thumbUpdatedAt',
  tags: ['persistent'],
});

const chat = defineTable(
  type({ id: 'string', msgDocId: 'string', msgUpdatedAt: 'number', _v: '1' }),
).withDocument('messages', {
  guid: 'msgDocId',
  updatedAt: 'msgUpdatedAt',
  tags: ['ephemeral'],
});

// ── Workspace ──
const syncUrl = 'wss://sync.example.com/{id}';

const workspace = createWorkspace({
  id: 'my-app',
  tables: { notes, images, chat },
})
  // Workspace extensions (workspace Y.Doc only)
  .withExtension('persistence', ({ ydoc }) => {
    const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
    return {
      exports: { clearData: () => idb.clearData() },
      lifecycle: { whenReady: idb.whenSynced, destroy: () => idb.destroy() },
    };
  })
  .withExtension('sync', ({ ydoc, awareness }) => {
    const provider = createSyncProvider({ doc: ydoc, url: syncUrl, awareness: awareness.raw });
    return {
      exports: { provider },
      lifecycle: { destroy: () => provider.destroy() },
    };
  })

  // Document extensions (content Y.Docs)
  // Persistence for docs tagged 'persistent'
  .withDocumentExtension('persistence', ({ ydoc }) => {
    const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
    return { whenReady: idb.whenSynced, destroy: () => idb.destroy() };
  }, { tags: ['persistent'] })

  // Sync only for docs tagged 'synced'
  .withDocumentExtension('sync', ({ ydoc }) => {
    const provider = createSyncProvider({ doc: ydoc, url: syncUrl });
    return { destroy: () => provider.destroy() };
  }, { tags: ['synced'] })

  // Ephemeral presence sync for docs tagged 'ephemeral'
  .withDocumentExtension('ephemeral-sync', ({ ydoc }) => {
    return createEphemeralSync(ydoc);
  }, { tags: ['ephemeral'] })

  // Actions (terminal, same as before)
  .withActions((client) => ({
    createNote: defineMutation({ ... }),
  }));
```

What each document gets:

| Table         | Tags                   | Document Extensions |
| ------------- | ---------------------- | ------------------- |
| notes.content | `persistent`, `synced` | persistence, sync   |
| images.thumb  | `persistent`           | persistence         |
| chat.messages | `ephemeral`            | ephemeral-sync      |

## Edge Cases

### Document with no tags, no universal extensions

If all document extensions specify tags and a document has no tags, it gets zero document extensions. The document opens as a bare Y.Doc with no providers. This is valid. The caller is responsible for ensuring documents get what they need.

### Multiple tags on a document, extension targets one

If a document has `tags: ['persistent', 'synced']` and an extension has `{ tags: ['synced'] }`, it fires. The extension matches if the doc's tags and extension's tags share ANY value (set intersection).

### Extension with multiple tags

If an extension has `{ tags: ['synced', 'ephemeral'] }`, it fires for any document that has at least one of those tags. This enables extensions that serve multiple document categories.

### Extension ordering

Document extensions fire in chain order (the order `.withDocumentExtension` is called), same as the current `onDocumentOpen` hook ordering. Each factory receives `whenReady` from all prior document extensions that fire for this document.

### Shared config between workspace and document extensions

Workspace sync and document sync may need the same URL/auth config. Since they're separate factories, shared config is extracted to a variable in the outer closure. This is a feature: it makes the dependency explicit.

### Migration from current API

The `onDocumentOpen` property on `Extension` is removed. Extensions that currently return `onDocumentOpen` need to be split into a workspace `withExtension` call and one or more `withDocumentExtension` calls. Documents that previously relied on universal `onDocumentOpen` hooks should add appropriate tags to their `withDocument` declarations.

### Cross-cutting: Dynamic workspace API

The `Extension` type in `shared/lifecycle.ts` is imported by **both** the static API (`static/`) and the dynamic workspace API (`dynamic/workspace/`). Removing `onDocumentOpen` from `Extension` affects both APIs. Specifically:

- `dynamic/extension.ts`: re-exports `Extension` and references `onDocumentOpen` in JSDoc (line 16)
- `dynamic/workspace/types.ts`: references `onDocumentOpen` in JSDoc for `withExtension` (line 161)
- `dynamic/workspace/create-workspace.ts`: imports `Extension` from shared lifecycle (line 29)

The dynamic API does **not** have `withDocument` or document bindings, so `withDocumentExtension` does not apply there. The change is limited to:

1. Removing `onDocumentOpen` from the shared `Extension` type (affects both APIs)
2. Updating JSDoc in dynamic API files that mention `onDocumentOpen`

The dynamic API does not gain `withDocumentExtension`: it has no document binding concept. If the dynamic API needs per-document extension hooks in the future, that's a separate design effort.

### Tags as a convention, not enforcement

Tags are strings. The system doesn't validate that a tag like `'persistent'` means the document actually has a persistence extension. Tags are a targeting mechanism, not a contract. Misspelled tags are caught at compile time (the union type rejects unknown values), but semantic correctness is the developer's responsibility.

## Implementation Plan

### Phase 1: Type definitions and builder changes

- [ ] **1.1** Add `TTags` generic parameter to `DocBinding` type in `types.ts`
- [ ] **1.2** Update `withDocument` method on `defineTable` to accept `tags` parameter with `const TTags` inference
- [ ] **1.3** Add `ExtractDocTags` and `ExtractAllDocTags` utility types to `types.ts`
- [ ] **1.4** Remove `onDocumentOpen` from `Extension` type in `lifecycle.ts`
- [ ] **1.5** Add `tags` to `DocumentContext.binding` in `lifecycle.ts`
- [ ] **1.6** Add `DocumentExtensionRegistration` internal type (stores key, factory, tags)
- [ ] **1.7** Add `withDocumentExtension` method to `WorkspaceClientBuilder` type
- [ ] **1.8** Add `TDocExtKeys` generic parameter to builder chain

### Phase 2: Runtime implementation

- [ ] **2.1** Implement `withDocumentExtension` on the builder in `create-workspace.ts`: accumulate registrations in internal array
- [ ] **2.2** Implement tag matching logic in `createDocumentBinding`: filter applicable extensions by comparing document tags with extension tags
- [ ] **2.3** Update `createDocumentBinding` to accept `tags` from table definition and pass through to `DocumentContext.binding`
- [ ] **2.4** Update table definition parsing in `createWorkspace` to pass tags through to document bindings

### Phase 3: Migrate existing consumers

- [ ] **3.1** Update `apps/fs-explorer` persistence extension to separate workspace + document extensions and add tags to document bindings
- [ ] **3.2** Update sync extension if it has `onDocumentOpen`
- [ ] **3.3** Update all tests in `create-workspace.test.ts` and `create-document-binding.test.ts`

### Phase 4: Cleanup

- [ ] **4.1** Remove `onDocumentOpen` from `Extension` type in `shared/lifecycle.ts` and all references
- [ ] **4.2** Remove `documentOpenHooks` array from `static/create-workspace.ts`
- [ ] **4.3** Update JSDoc in `dynamic/extension.ts`: remove `onDocumentOpen` from description (line 16)
- [ ] **4.4** Update JSDoc in `dynamic/workspace/types.ts`: remove `onDocumentOpen` from `withExtension` description (line 161)
- [ ] **4.5** Update JSDoc on all other affected types and functions

## Open Questions

1. **Should `withDocumentExtension` factories receive workspace extension exports?**
   - Current `onDocumentOpen` doesn't have access to workspace extensions. The new design could optionally pass `extensions` in the `DocumentContext`.
   - **Recommendation**: Don't pass them. Document extensions should be self-contained. If they need shared config (like a sync URL), extract it to a variable. Passing workspace extensions creates coupling.

2. **Should tag values be validated at `createWorkspace` time?**
   - We could check that every `withDocumentExtension` tag matches at least one tag declared in a table's `withDocument`.
   - **Recommendation**: Yes, runtime warning in development via `console.warn`. Not a hard error: an extension targeting a non-existent tag simply never fires. TypeScript catches most typos at compile time via the `ExtractAllDocTags` union.

3. **Should `except` be added as an escape hatch?**
   - The include-only design requires explicit tagging of all document types. If an app has 20+ document types and most need persistence, listing all tags is tedious.
   - **Recommendation**: Defer. Start with include-only. If the pain point surfaces, adding `except?: Tag[]` to the options bag is backward-compatible and doesn't affect existing code.

4. **Should the `withDocumentExtension` factory receive the workspace Y.Doc?**
   - Current `onDocumentOpen` doesn't. The factory only gets the content Y.Doc.
   - **Recommendation**: No. Document extensions operate on content Y.Docs only. If you need the workspace doc, use a workspace extension.

## Success Criteria

- [ ] `withExtension` no longer accepts or returns `onDocumentOpen`
- [ ] `withDocumentExtension` registers document-scoped extension factories with optional `{ tags }` scoping
- [ ] Tag matching uses set intersection (fires if doc tags and extension tags share any value)
- [ ] `withDocument` accepts optional `tags: TTags | readonly TTags[]` with `const` type inference
- [ ] `ExtractAllDocTags` utility type collects all tag literals from all table definitions
- [ ] Tags autocomplete in `withDocumentExtension` options from inferred union
- [ ] Existing tests updated or replaced
- [ ] fs-explorer migrated to new API
- [ ] TypeScript generics accumulate document extension keys via `TDocExtKeys`

## References

- `packages/epicenter/src/static/create-workspace.ts`: Main builder implementation, has current `onDocumentOpen` hook wiring
- `packages/epicenter/src/static/create-document-binding.ts`: Runtime document binding, manages content Y.Doc lifecycle
- `packages/epicenter/src/shared/lifecycle.ts`: Extension and DocumentLifecycle types (shared by static + dynamic APIs)
- `packages/epicenter/src/static/types.ts`: Builder types, `DocBinding`, `WorkspaceClientBuilder`
- `packages/epicenter/src/static/define-table.ts`: `withDocument` method, `DocBinding` type
- `packages/epicenter/src/dynamic/extension.ts`: Dynamic API extension re-exports (references `onDocumentOpen` in JSDoc)
- `packages/epicenter/src/dynamic/workspace/types.ts`: Dynamic API builder types (references `onDocumentOpen` in JSDoc)
- `packages/epicenter/src/dynamic/workspace/create-workspace.ts`: Dynamic API builder (imports `Extension` from shared lifecycle)
- `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts`: Real consumer that mixes workspace + document persistence
- `packages/epicenter/src/extensions/sync.ts`: Sync extension (workspace-level, may need document counterpart)
- `packages/epicenter/src/static/create-workspace.test.ts`: Tests for extension wiring and document bindings

## Review

**Status**: Complete: all 4 phases implemented and verified.

### Changes Summary

**Phase 1: Types** (7 files touched):

- `types.ts`: Added `TTags` generic to `DocBinding`, `DocumentExtensionRegistration` type, `ExtractDocTags`/`ExtractAllDocTags` utility types, `withDocumentExtension` method on `WorkspaceClientBuilder`, `TDocExtKeys` generic
- `lifecycle.ts`: Removed `onDocumentOpen` from `Extension` type, added `tags: readonly string[]` to `DocumentContext.binding`
- `define-table.ts`: `withDocument` now accepts optional `tags` param with `const TTags` inference, runtime normalization of single-string to array

**Phase 2: Runtime** (2 files touched):

- `create-workspace.ts`: Replaced `documentOpenHooks` with `documentExtensionRegistrations` array, implemented `withDocumentExtension` builder method, passes tags config through to `createDocumentBinding`
- `create-document-binding.ts`: New config shape `{ documentExtensions, documentTags }` replacing `{ onDocumentOpen }`, tag matching via set intersection filter in `open()`

**Phase 3: Consumer Migration** (2 files touched):

- `fs-state.svelte.ts`: Split persistence into workspace `withExtension` + `withDocumentExtension('persistence', ..., { tags: ['persistent'] })`
- `file-table.ts`: Added `tags: 'persistent'` to `filesTable`'s `withDocument` call
- Sync extension (`sync.ts`): No changes needed: had no `onDocumentOpen`

**Phase 4: Cleanup** (4 files touched):

- Removed all `onDocumentOpen` and `documentOpenHooks` references from JSDoc in `create-document-binding.ts`, `create-workspace.ts`, `dynamic/extension.ts`, `dynamic/workspace/types.ts`

**Tests**:

- `create-workspace.test.ts`: Replaced `onDocumentOpen` test with `withDocumentExtension` test + tag matching test
- `create-document-binding.test.ts`: Rewrote purge tests and hook tests for new `documentExtensions` config, added 5 tag matching tests (universal, matching, non-matching, no-tags-on-doc)
- `define-table.test.ts`: Added 3 tests for `withDocument` tags (single string, array, omitted), fixed pre-existing `toEqual` type issues caused by `DocBinding` generic change
- **Result**: 182 pass, 0 fail (up from 174 baseline: 8 new tests added)

### Design Decisions Made During Implementation

1. **Tag matching is set intersection**: Extension fires if `extension.tags ∩ doc.tags ≠ ∅`. Extensions with empty tags are universal (fire for all docs).
2. **Tags normalized at definition time**: Single string `'persistent'` is converted to `['persistent']` in `addWithDocument` runtime, stored as `readonly string[]`.
3. **`DocBinding` conditional tags field**: `tags?: [TTags] extends [never] ? undefined : readonly TTags[] | TTags`: when no tags declared, the field type is `undefined` (not just optional).
4. **`DocumentExtensionRegistration` stores `tags: readonly string[]`**: Empty array for universal extensions (no optional, no undefined: simplifies runtime filtering).
5. **Existing `define-table.test.ts` assertions changed from `toEqual` to field-by-field**: The `Record<string, never>` default in `TDocs` creates impossible intersections with `toEqual`'s type overloads after adding the `TTags` generic. Field-by-field `toBe`/`toBeUndefined` assertions avoid this while testing the same behavior.
