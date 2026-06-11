---
name: attach-primitive
description: Contract and invariants for `attach*` composition primitives in `packages/workspace` (side-effectful building blocks like attachIndexedDb, attachSqlite, attachBroadcastChannel, attachBunSqliteMaterializer, attachMarkdownMaterializer, openCollaboration), and when to use `create*` (pure construction) instead. Use when writing or reviewing an `attach*` or `create*` function, naming a new workspace primitive, composing inside a workspace builder, or deciding whether a primitive registers listeners at call time.
---

# Attach Primitives

Every persistence, sync, materializer, and binding in `packages/workspace` (plus session-shaped primitives in `packages/cli`) follows one shape. Match the invariants exactly.

## Naming

| Prefix     | Meaning                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `attach*`  | Side-effectful. Registers observers, destroy listeners, or subscription state **onto a subject argument**. Returns a plain object whose surface is fixed at call time. |
| `create*`  | Pure construction OR module-singleton bootstrap. No subject argument. Cache constructors qualify (e.g. `createFileContentDocs` returns a `createDisposableCache` result; nothing attaches until `.open(id)` is called). Module-singleton factories that bootstrap themselves at construction time (e.g. `createManualRecorder` registering a global event listener) also use `create*`: the side effects belong to the singleton itself, not to an external subject. |

Both return plain objects. The distinction is **whether the call modifies a subject argument**, not just whether side effects fire at call time.

### Scope of this contract

These rules apply to `packages/workspace` primitives and other functions that take a *subject* (a Y.Doc, an attachment, or a comparable composable target) and decorate it. They do **not** apply to:

- Module-level factory singletons in app code (e.g. UI state containers, service clients). Even if those factories perform I/O at construction time, use `create*`.
- Top-level orchestrators that own their own lifecycle and aren't attached to anything external.

The discriminator is **"what is being attached to what?"** If there's no `subject` on the left side of that question, it's `create*`.

## The shape

```ts
export function attachX(subject: TSubject, opts: XOptions): XAttachment;
```

**One rule.** The first argument is the subject being modified. The subject is almost always a `Y.Doc`. In the rare case where a primitive operates on an existing attachment rather than a ydoc, the subject is that attachment.

Examples of the common form:

```ts
attachIndexedDb(ydoc)                   // Y.Doc subject
attachSqlite(ydoc, { filePath })
openCollaboration(ydoc, { url, openWebSocket, replicaId, actions })
attachBroadcastChannel(ydoc)
attachAwareness(ydoc, defs)
attachRichText(ydoc) / attachPlainText(ydoc) / attachTimeline(ydoc)
```

Table and KV stores are no longer attached one-by-one. They are constructed as a bundle by `createWorkspace({ id, tables, kv, keyring? })`, which owns the Y.Doc's lifecycle and exposes `workspace.ydoc`, `workspace.tables`, and `workspace.kv`. Pass `workspace.ydoc` into the remaining `attach*` primitives; pass the whole `workspace` bundle (the `{ ydoc, tables }` pair) into the materializers.

**Materializers** take the `workspace` bundle as the subject (not a bare ydoc): `attachX(workspace, opts)`. They read `workspace.tables` themselves; you do not pass a separate `tables` slot. The two materializer families select what to mirror differently, on purpose:

- **SQLite** mirrors *every* table in `workspace.tables`. A full queryable mirror is cheap and wanted, so there is no selection slot. `fts` is optional per-table config, keyed by table name.
- **Markdown** mirrors a *human-facing subset*. Dumping every internal table as `.md` files is unwanted, so selection is required: `perTable[name]` presence selects the table, and its value configures it. A table with no `perTable` entry is skipped. Pass `{}` to mirror a table with all defaults.

```ts
attachMarkdownMaterializer(workspace, {
  dir,
  waitFor,
  perTable: {
    // Presence selects; the value configures. Tables absent here are skipped.
    files: {
      filename: slugFilename('title'),
      // Most real tables store body content in a separate Y.Doc (via
      // createDisposableCache), so toMarkdown / fromMarkdown are typically
      // bespoke callbacks; no sugar helper can abstract the async
      // open/await/dispose cycle usefully.
      toMarkdown: async (row) => {
        using doc = fileContentDocs.open(row.id);
        await doc.whenReady;
        return { frontmatter: { id: row.id, name: row.name }, body: doc.content.read() };
      },
    },
    devices: {}, // selected, all defaults
  },
});

attachBunSqliteMaterializer(workspace, {
  filePath,
  waitFor,
  fts: { posts: ['title'] },
});
```

Per-table customization lives in `perTable: { [tableName]: { ... } }` (markdown) and FTS column opt-in lives in `fts: { [tableName]: ColumnKey[] }` (SQLite). Both slots narrow against `keyof workspace.tables`, so keys autocomplete and typos error at the call site.

The SQLite result surfaces FTS on a nested namespace: `sqlite.fts.search({ table, query })` exists when `fts: {...}` was passed; when omitted, `sqlite.fts` is absent from the return type entirely. Single attach call, single `whenFlushed` barrier; the FTS DDL and triggers run between table DDL and the bulk insert so triggers populate `<table>_fts` for free.

## Non-Ydoc Subject (rare)

When a primitive operates on a sibling attachment rather than the Y.Doc itself (cross-package coordination, for example), the subject is that attachment and the call shape stays `attachX(subject, opts)`. No examples currently in the repo; the pattern is documented in case it ever surfaces.

## Constructor bundles (the workspace case)

When several sibling handles must be constructed atomically (one Y.Doc, N stores activated together, optionally one keyring derivation feeding them all), that work lives in `createWorkspace`, not in an `attach*` primitive. The factory takes definition records as named slots and returns the constructed handles as a bundle:

```ts
// Plaintext
const workspace = createWorkspace({
  id: 'my-app',
  tables: { posts },
  kv: {},
});

// Encrypted: same call shape, `keyring` switches it on
const workspace = createWorkspace({
  id: 'my-app',
  keyring: signedIn.keyring,
  tables: { posts },
  kv: {},
});

workspace.ydoc;                    // Y.Doc bundled in
workspace.tables.posts;            // constructed table helper
workspace.kv;                      // constructed KV bag
workspace[Symbol.dispose]();       // cascades to ydoc.destroy()
```

The workspace bundle owns the stores' lifecycle: `using workspace = createWorkspace(...)` triggers cascade disposal. Passing `keyring` switches encryption on at construction; without it the stores are plaintext. One call, atomic registration, no temporal window for mid-session attachment.

The materializer primitives are the remaining "subject in, constructed handle out" `attach*` shape: see the materializer block above. They take the `workspace` bundle as the subject, read `workspace.tables` themselves, and accept a `perTable` (markdown) or `fts` (SQLite) sibling slot for per-table customization.

## Invariants

1. **Synchronous return.** Construction never awaits. Startup work goes into semantic `when*` promises on the returned object. Genuine async teardown exposes a `whenDisposed` promise field resolved from the `ydoc.destroy()` cascade.
2. **Teardown hooked to the subject's lifecycle.**
   - Y.Doc subject: `ydoc.once('destroy', ...)`. Never expose a `.destroy()` method on the attachment.
   - Attachment subject: use the subject attachment's disposal signal; or no teardown if there are no listeners.
3. **Idempotent cleanup.** If the underlying library also registers a destroy handler (like `y-indexeddb`), your handler must be safe to run alongside it.
4. **Plain data returned.** The attachment is a record of promises, functions, and occasionally mutable state. No ES classes, no getters that lazy-init.
5. **No id option on ydoc-bound primitives.** `ydoc.guid` is the identity. Read it off the doc.
6. **Barrier naming is semantic, not mechanical.** Pick the name that describes the actual event:
   - `whenLoaded`: local state replayed into the ydoc (IDB, SQLite)
   - `whenConnected`: remote transport up + first exchange done (sync)
   - `whenChecked`: configuration action settled (session-unlock; resolves even if nothing was applied)
   - `whenFlushed`: initial side-effect pass done (materializer)
   - `whenReady`: bundle-level aggregate only; not on individual attachments

## Composition inside a workspace builder

Primitives compose inside a build closure:

```ts
const cache = createDisposableCache((id: string) => {
  const workspace = createWorkspace({
    id,
    keyring,
    tables: schema,
    kv: kvDefs,
  });
  const { ydoc, tables, kv } = workspace;
  const idb        = attachIndexedDb(ydoc);
  const collaboration = openCollaboration(ydoc, {
    url, openWebSocket, replicaId, actions,
    waitFor: idb.whenLoaded,
  });
  const markdown   = attachMarkdownMaterializer(workspace, {
    dir,
    waitFor: collaboration.whenConnected,
    perTable: { posts: { filename: slugFilename('title') } },
  });

  return {
    workspace, ydoc, tables, kv, idb, collaboration, markdown,
    whenReady: Promise.all([idb.whenLoaded, collaboration.whenConnected]),
    async wipe() {
      workspace[Symbol.dispose]();
      await collaboration.whenDisposed;
      await idb.whenDisposed;
      await idb.clearLocal();
    },
    [Symbol.dispose]() { workspace[Symbol.dispose](); },
  };
});

export const bundle = cache.open('my-app');
```

The bundle aggregates child `whenLoaded` / `whenConnected` / `whenChecked` into one `whenReady`. Browser bundles expose `wipe()` for reset flows that must dispose and delete local storage in the right order. Daemon bundles expose `[Symbol.asyncDispose]()` as the trigger and await attachment `whenDisposed` barriers before process exit.

## The `waitFor` convention

Primitives that perform a gated startup (collaboration, session-unlock) accept `waitFor?: Promise<unknown>` in their options. The primitive awaits it before taking its first action. This replaces the old extension-chain "init pipeline": sequencing is now explicit at the call site, visible in one file, with no hidden ordering.

Use it whenever a primitive's startup must follow another's. Examples:
- `openCollaboration` after local hydrate: `waitFor: idb.whenLoaded`
- `attachSessionUnlock` after hydrate (so stored keys don't clobber freshly-hydrated plaintext mid-replay): `waitFor: persistence.whenLoaded`
- `openCollaboration` after both hydrate AND unlock: `waitFor: Promise.all([idb.whenLoaded, unlock.whenChecked])`

## Anti-patterns

- **Don't revive `ExtensionContext` / `RawExtension` / `defineExtension`.** Those were deleted for a reason: the lifecycle framework added a registration indirection that primitives don't need.
- **Don't wrap attachments in a `createWorkspace().with(...)` chain.** Compose inline in the factory.
- **Don't expose `dispose()` on a ydoc-bound attachment.** Destroy the Y.Doc.
- **Don't duck-type an attachment.** If you need to brand it, use a `Symbol.for` marker. See `skills/typescript`: runtime shape-checking is a code smell.
- **Don't take an `id` on a ydoc-bound primitive.** Use `ydoc.guid`.
- **Don't use `createX` for a side-effectful primitive that takes a subject argument.** If it registers listeners on a subject passed in, it's `attach*`. Module-singleton factories that bootstrap themselves are still `create*`; see scope section.
- **Don't introduce a separate top-level encrypted-X helper.** Encryption is a construction-time switch on `createWorkspace({ id, keyring, tables, kv })`, not an `attach*` primitive. If you find yourself reaching for an `attachEncryption` shape, the work belongs in the workspace bundle factory instead.
- **Don't attach tables or KV stores one-by-one on a raw Y.Doc.** Construct them as a bundle via `createWorkspace`; pass `workspace.ydoc` into the remaining `attach*` primitives.

## Reference implementations

- `packages/workspace/src/document/attach-indexed-db.ts` ; the canonical 40-line example.
- `packages/workspace/src/document/open-collaboration.ts` ; document collaboration surface with sync, presence, peers, and action dispatch.
- `packages/workspace/src/create-workspace.ts` ; the bundle factory; takes `{ id, tables, kv, keyring? }` and returns `{ ydoc, tables, kv, [Symbol.dispose] }` after one atomic construction (and one keyring derivation when encrypted).
- `packages/workspace/src/document/materializer/markdown/materializer.ts` ; `workspace` subject, `perTable` presence both selects and configures, keyed by table name.
- `apps/whispering/src/lib/client.ts`: full singleton composition.
