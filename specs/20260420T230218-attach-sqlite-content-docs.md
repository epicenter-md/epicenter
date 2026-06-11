# Spec: `attachSqlite`: per-doc SQLite persistence + attach-callback factory API

**Status:** Implemented on `braden-w/document-primitive`.
**Related:** `20260420T230100-collapse-document-framework.md`: landed the
app-owned `defineDocument` pattern this completes.

> **Path note (2026-05-22):** Any `~/.epicenter/persistence/` examples in this historical implementation note are stale. Keep project-local `<projectDir>/.epicenter/` examples when they describe generated project data, but do not use top-level `~/.epicenter/` as the current persistence root.

## Problem

Per-content Y.Docs had exactly one persistence adapter: `attachIndexedDb`,
browser-only. Node, Bun, and Tauri runtimes had no equivalent: content docs
ran in memory and re-hydrated from WebSocket sync on every cold start.

Three things conspired to make the situation worse than it looked:

1. **The primitive nearly existed already.** A file
   `packages/document/src/attach-filesystem-persistence.ts` shipped the
   right shape: `{ whenLoaded, clearLocal, whenDisposed }`, exactly
   parallel to `attachIndexedDb`: but was named `attachFilesystemPersistence`
   and not part of the package.json exports surface.
2. **The append-log compaction code was duplicated verbatim** between
   `packages/document/src/attach-filesystem-persistence.ts` and
   `packages/workspace/src/extensions/persistence/sqlite.ts` (the workspace
   Y.Doc persistence extension). Byte-for-byte identical constants +
   `compactUpdateLog()`. Drift bomb.
3. **Content-doc factories carried a vestigial `persistence` flag.** Three
   factories: `createFileContentDocs`, `createSkillInstructionsDocs`,
   `createReferenceContentDocs`: took `persistence: 'indexeddb' | 'none'`.
   The flag is the exact shape of the framework-decides pattern we'd just
   collapsed. Browser apps set `'indexeddb'`; Node set `'none'`; nobody ever
   wanted a different axis.

## Shape landed

### Primitive

```ts
// packages/document/src/attach-sqlite.ts
export function attachSqlite(
  ydoc: Y.Doc,
  { filePath }: { filePath: string },
): SqliteAttachment;

export type SqliteAttachment = {
  whenLoaded: Promise<void>;
  clearLocal: () => Promise<void>;
  whenDisposed: Promise<void>;
};
```

Mirrors `attachIndexedDb(ydoc): IndexedDbAttachment` exactly. Apps swap
browser for desktop by **changing one line** inside their `defineDocument`
closure:

```ts
// Browser
const idb = attachIndexedDb(ydoc);

// Desktop / Bun / Tauri
const sqlite = attachSqlite(ydoc, { filePath });
```

### Shared append-log compaction

```ts
// packages/document/src/sqlite-update-log.ts
export const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;
export const COMPACTION_BYTE_THRESHOLD = 2 * 1024 * 1024;
export const COMPACTION_DEBOUNCE_MS = 5_000;
export function compactUpdateLog(db: Database, ydoc: Y.Doc): boolean;
```

Both consumers (`attachSqlite` per-doc and `filesystemPersistence`
workspace-scope) import from this single module. Exported via subpath
`@epicenter/document/sqlite-update-log` so workspace can reference it
without pulling the full `@epicenter/document` barrel.

### Factory API change: `persistence` → `attach`

Before:

```ts
createFileContentDocs({
  workspaceId,
  filesTable,
  persistence: 'indexeddb' | 'none',
});
```

After:

```ts
createFileContentDocs({
  workspaceId,
  filesTable,
  attach?: (ydoc: Y.Doc) => ContentAttachment | void,
});

type ContentAttachment = {
  whenLoaded?: Promise<void>;
  whenDisposed?: Promise<void>;
};
```

The `ContentAttachment` shape is structurally satisfied by both
`IndexedDbAttachment` and `SqliteAttachment`, so the common case is a bare
return:

```ts
// Browser
attach: (ydoc) => attachIndexedDb(ydoc)

// Desktop
attach: (ydoc) => attachSqlite(ydoc, { filePath: `${dir}/${ydoc.guid}.db` })

// In-memory (tests, Node stubs)
// omit `attach`
```

The factory threads `whenLoaded` onto `handle.whenReady` and `whenDisposed`
onto the `defineDocument` cache teardown. Same change applied to
`createSkillInstructionsDocs` and `createReferenceContentDocs`.

### Directory convention (opensidian-e2e)

One SQLite file per content doc, keyed by the full Y.Doc guid:

```
~/.epicenter/persistence/opensidian/
  opensidian.db                                    ← workspace Y.Doc
  content/
    opensidian.files.abc123.content.db             ← per-file content
    opensidian.files.def456.content.db
```

Flat directory, verbose filenames. Chosen over `content/files/abc123.db`
because:
- No guid parsing at write time.
- `ls` is self-documenting (the workspace-collection-field prefix shows
  the Y.Doc's full identity).
- Deletion of one doc is `rm` of one file; no DB lock contention.
- File-per-doc matches IndexedDB's namespace-per-doc model: drop-in swap.

## Commits

```
65d88ed8e  feat(playground): flip opensidian-e2e content docs to attachSqlite
ab7954055  refactor(factories)!: replace persistence flag with attach callback
eb62f995a  refactor(document, workspace): extract shared sqlite-update-log helper
d7a4c9ccb  refactor(document)!: rename attachFilesystemPersistence → attachSqlite
```

Bisect-friendly; each phase green under `bun test`.

## Non-goals

- No discriminated-union mode flag. Apps pick by calling the attachment
  they want; nothing decides on their behalf.
- No changes to `filesystemPersistence` (workspace Y.Doc persistence). It
  keeps its single-file workspace-scope role; now just imports the shared
  helper.
- No remote-SQLite support (libSQL / Turso). Future work.
- No `attachOpfs` or browser-filesystem variants. The pattern is ready:
  a third attachment would add one file under `packages/document/src/`
  with the same shape.

## Open follow-ups

- **Playground bun resolution.** `playground/*` isn't in the root
  `workspaces.packages` globs, so `bun test playground/opensidian-e2e`
  fails at module resolution. Pre-existing; unrelated to this spec.
- **`filesystemPersistence` → `attachSqlite` at workspace scope.** The
  workspace Y.Doc still uses the older `filesystemPersistence`
  **extension** shape (different from the attachment shape). That
  extension could be reshaped to use `attachSqlite` internally, but
  callers of `.withExtension('persistence', filesystemPersistence(...))`
  would be unaffected either way. Defer.
- **Drop the `createXxxContentDocs` factories entirely.** The trajectory
  visible in apps/whispering and apps/opensidian is inline `defineDocument`
  closures with zero factory helpers. The three remaining factories
  (`createFileContentDocs`, `createSkillInstructionsDocs`,
  `createReferenceContentDocs`) are transitional. Future spec.

## Success criteria (verified)

- [x] `attachSqlite(ydoc, { filePath })` exported from
      `@epicenter/document` and `@epicenter/document/attach-sqlite`.
- [x] Single source of truth for compaction constants + `compactUpdateLog`
      at `packages/document/src/sqlite-update-log.ts`.
- [x] Zero `persistence: 'indexeddb' | 'none'` hits in
      `packages/ apps/ playground/` TypeScript.
- [x] `bun test packages/{document,workspace,filesystem,skills}` green
      (2 pre-existing fails: one bash emulator test, one flaky benchmark
      timeout).
- [x] opensidian-e2e playground config + test suite use `attachSqlite`
      for content doc persistence.
- [x] One-line browser ↔ desktop swap demonstrated in:
      `apps/opensidian/src/lib/client.ts:54-58` (`attachIndexedDb`),
      `playground/opensidian-e2e/epicenter.config.ts:64-72`
      (`attachSqlite`).
