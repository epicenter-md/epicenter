# Workspace API

A typed interface over Y.js for apps that need to evolve their data schema over time.

## The Idea

This is a wrapper around Y.js that handles schema versioning. Local-first apps can't run migration scripts, so data has to evolve gracefully. Old data coexists with new. The Workspace API bakes that into the design: define your schemas once with versions, write a migration function, and everything else is typed.

It's structured in three layers. Start at the top, drop down when you need control:

```
┌────────────────────────────────────────────────┐
│  Your App                                      │
├────────────────────────────────────────────────┤
│  defineWorkspace() → createWorkspace()         │ ← Most apps
│  ↓ Result: WorkspaceClient                     │
│  { tables, kv, documents, awareness, extensions } │
├────────────────────────────────────────────────┤
│  createTables(ydoc, {...})                     │ ← Need control
│  createKv(ydoc, {...})                         │
├────────────────────────────────────────────────┤
│  Y.Doc (raw CRDT)                              │ ← Escape hatch
│  ↓ Storage: table:posts, table:users, kv      │
└────────────────────────────────────────────────┘
```

## The Pattern: define vs create

This codebase uses two prefixes consistently. `define*` is pure—no Y.Doc, no side effects. `create*` does instantiation:

```typescript
// Pure schema definitions
const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

const workspace = defineWorkspace({ id: 'my-app', tables: { posts } });

// Creates Y.Doc and returns a typed client
const client = createWorkspace(workspace);

// Or bring your own Y.Doc
const tables = createTables(myYdoc, { posts });
```

For most apps, just call `createWorkspace(definition)` and you're done. It's synchronous, returns immediately, and everything is typed.

## If You Need More

### Extensions

Extensions add capabilities (persistence, sync, indexing) without baking them into the core. Three registration methods target different scopes:

```typescript
const client = createWorkspace({
	id: 'my-app',
	tables: { posts },
})
	// Dual-scope: registers for BOTH the workspace Y.Doc and every content Y.Doc.
	// The factory only receives { ydoc, whenReady }—the minimal shared contract.
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('broadcast', broadcastChannelSync)

	// Workspace-only: receives the full ExtensionContext (tables, kv, awareness, etc.)
	.withWorkspaceExtension('sync', createSyncExtension({ url: '...' }))
	.withWorkspaceExtension('sqliteIndex', createSqliteIndex())

	// Document-only: receives DocumentContext (timeline, ydoc, id, whenReady, extensions)
	.withDocumentExtension('indexer', docIndexer);
```

`withExtension` is sugar—it calls both `withWorkspaceExtension` and `withDocumentExtension` with the same factory. If a factory needs scope-specific fields (tables, awareness, timeline), register it with the scoped method instead.

Each factory returns a flat object with custom exports alongside optional `whenReady` and `destroy`. The framework normalizes defaults internally.

```typescript
// What each scope receives:
//
// withExtension        → { ydoc, whenReady }  (SharedExtensionContext)
// withWorkspaceExtension → { id, ydoc, tables, kv, awareness, documents,
//                          definitions, extensions, whenReady, batch,
//                          loadSnapshot }  (ExtensionContext)
// withDocumentExtension  → { id, ydoc, timeline, extensions,
//                          whenReady }  (DocumentContext)
```

### Lower-Level APIs

If you have a shared Y.Doc (collaboration server, multiple workspaces), skip the high-level wrapper:

```typescript
const ydoc = collaborationProvider.ydoc;
const tables = createTables(ydoc, { posts });
const kv = createKv(ydoc, { theme });

tables.posts.set({ id: '1', title: 'Hello' });
```

You lose the workspace wrapper and automatic lifecycle, but keep full type safety and control.

## Design Decisions

The code makes specific bets about what matters. Worth knowing upfront:

**Row-level atomicity.** `set()` replaces the entire row. No field-level updates. This keeps consistency simple when data migrates—you don't have to ask "should I merge old fields with new?" Every write is a complete row in the latest schema. If you're updating a field, read it first:

```typescript
const result = posts.get('1');
if (result.status === 'valid') {
	posts.set({ ...result.row, views: result.row.views + 1 });
}
```

**Migration on read, not on write.** Old data transforms when you load it, not when you write. Old rows stay old in storage until explicitly rewritten. This enables rollback and means you don't pay the migration cost at startup.

**No write validation.** Writes aren't validated at runtime. TypeScript's job is to ensure the types are right; if you write garbage, reads will catch it and return invalid. Validation at write time is mostly overhead—the real bugs come from data corruption you didn't expect.

**No field-level observation.** You observe entire tables or KV keys, not individual fields. This keeps the API simple. Let your UI framework handle field reactivity.

For detailed rationale on all of this, see [the guide](docs/articles/20260127T120000-static-workspace-api-guide.md).

## Document Content

Tables with `.withDocument()` create per-row Y.Docs for content. These Y.Docs use a **timeline model** (`Y.Array('timeline')` with nested typed entries) in `packages/workspace/src/timeline/`.

The handle is the canonical interface: `handle.read()`/`handle.writeText()` for simple string I/O, `handle.asText()` for Y.Text editor binding, `handle.asRichText()` for Y.XmlFragment richtext binding, `handle.asSheet()` for spreadsheet binding, `handle.timeline` for advanced operations, and `handle.batch()` for batching mutations. The `as*()` methods automatically convert between content modes—all conversions are infallible.

See `specs/20260313T230000-promote-timeline-to-workspace.md` for the full design.

## Testing

The tests are in `*.test.ts` files next to the implementation. Use `new Y.Doc()` for in-memory tests. Migrations are validated by reading old data and checking the result. Look at existing tests for patterns.

## Go Deeper

- [API Guide](docs/articles/20260127T120000-static-workspace-api-guide.md) - Examples, patterns, when to use what
- [Specification](specs/20260126T120000-static-workspace-api.md) - Full API reference
- [Storage Internals](specs/20260125T120000-versioned-table-kv-specification.md) - How versioning works under the hood
