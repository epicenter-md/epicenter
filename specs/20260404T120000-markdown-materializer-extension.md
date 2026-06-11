# Markdown Materializer Extension

**Date**: 2026-04-04
**Status**: Implemented
**Author**: AI-assisted

## Overview

A workspace extension that projects Y.Doc table rows into human-readable markdown files on disk. Each row becomes a `.md` file with YAML frontmatter. One-way initially (Y.Doc → files), with bidirectional sync as a future phase.

## Motivation

### Current State

The CLI E2E harness (`playground/tab-manager-e2e`) syncs the tab-manager workspace to a local SQLite file:

```typescript
// playground/tab-manager-e2e/epicenter.config.ts
export const tabManager = createTabManagerWorkspace()
  .withExtension('persistence', filesystemPersistence({
    filePath: join(PERSISTENCE_DIR, 'epicenter.tab-manager.db'),
  }))
  .withExtension('sync', createSyncExtension({ ... }));
```

The SQLite file stores the raw Y.Doc update log. Binary blobs you can't read, grep, or pipe through standard tools. If you want to see your saved tabs or bookmarks, you run `epicenter list savedTabs`. No way to browse the data as files, diff it in git, or feed it to other tools.

### Problems

1. **Opaque local data**: The `.db` file is a binary blob. You can't grep your bookmarks, pipe them to `jq`, or open them in a text editor.
2. **No git-friendly format**: Teams or power users who want version-controlled workspace data have no path to it.
3. **No interop with file-based tools**: Obsidian, VS Code markdown preview, static site generators. None can read the binary persistence.

### Desired State

```
playground/tab-manager-e2e/data/
├── savedTabs/
│   ├── github-pr-review-abc123.md
│   └── stack-overflow-rust-lifetimes-def456.md
└── bookmarks/
    ├── react-docs-ghi789.md
    └── tailwind-css-jkl012.md
```

Each file:

```markdown
---
id: abc123
url: https://github.com/EpicenterHQ/epicenter/pull/42
title: "GitHub PR Review"
favIconUrl: https://github.com/favicon.ico
pinned: false
sourceDeviceId: device_xyz
savedAt: 1712345678000
_v: 1
---
```

## Research Findings

### The Deleted Markdown Extension

Commit `d2c5e087` removed a fully-featured markdown extension (1,537 lines in `markdown.ts` alone) along with the Dynamic schema system it depended on. Key files:

| File | Lines | Purpose |
|------|-------|---------|
| `extensions/markdown/markdown.ts` | 1,537 | Core extension: bidirectional sync, observers, file watcher |
| `extensions/markdown/configs.ts` | 752 | Serializer factories: `defaultSerializer`, `bodyFieldSerializer`, `titleFilenameSerializer` |
| `extensions/markdown/diagnostics-manager.ts` | 380 | Real-time error tracking JSON file |
| `extensions/markdown/io.ts` | 163 | Read/write markdown files with frontmatter parsing |
| `extensions/markdown/index.ts` | 42 | Public exports |

**Why it was deleted**: Tightly coupled to the Dynamic API (`ExtensionContext<TTableDefinitions>`, `Field`, `Row<Field[]>`, `TableDefinition`). The Dynamic system was replaced by the Static API (arktype schemas, `defineTable`, `defineWorkspace`). The extension couldn't survive without its foundation.

**What was well-designed** (worth preserving in spirit):

- **Sync coordination counters** (not booleans) to prevent infinite loops during bidirectional sync. Counters handle concurrent async operations where booleans race.
- **Per-table serializer config** via factory functions (`bodyFieldSerializer('content')`, `titleFilenameSerializer('title')`).
- **Filename tracking map** (`Map<rowId, filename>`) to detect renames when a title field changes.
- **Granular diffs**: Character-level for text, element-level for arrays. Avoids blowing away CRDT history with wholesale replacement.

**What we don't need from it** (for Phase 1):

- **Chokidar file watcher** (file → Y.Doc). Bidirectional sync is ~60% of the complexity. One-way projection is enough for the CLI use case.
- **Dynamic schema introspection**. The old code iterated `tables.definitions` as a `TableDefinition[]`. The Static API exposes tables differently.

### Current Extension Contract

Extensions are factory functions that receive the workspace client context and return exports:

```typescript
// From indexeddb.ts: the simplest extension
export function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
  return {
    clearLocalData: () => idb.clearData(),
    whenReady: idb.whenSynced,
    dispose: () => idb.destroy(),
  };
}
```

The factory receives `{ ydoc, tables, id, ... }` (the "client-so-far") from the builder chain. It can return anything. The exports become available at `client.extensions.<key>`.

The `tables` object exposes `.observe(callback)` per table, where the callback receives `Map<id, 'add' | 'update' | 'delete'>`. This is the primary hook for reactive materialization.

### Encryption Considerations

Table rows may be encrypted via `createEncryptedYkvLww`. The markdown materializer reads rows via the public `tables` API (`getAllValid()`, `get(id)`), which returns **decrypted** values. So encryption is transparent. The materializer never touches ciphertext. This means:

- Markdown files on disk contain **plaintext** data
- This is intentional. The whole point is human-readable files
- Users should understand that `.md` output is unencrypted

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Direction | One-way (Y.Doc → files) initially | Bidirectional adds chokidar, sync coordination, and granular diff complexity. CLI use case only needs read-optimized projection. |
| File format | YAML frontmatter + optional body | Matches the deleted extension, standard in static site generators, parseable by any YAML library |
| Serializer pattern | Factory functions per table | Proven pattern from the old extension. Different tables need different output (tabs want title filenames, bookmarks want URLs) |
| Observe mechanism | `table.observe()` per table | Built into the workspace API, fires on add/update/delete with batched changes per Y.Transaction |
| File naming | Configurable via serializer, default `{id}.md` | `titleFilenameSerializer` produces `{slugified-title}-{id}.md` for human browsing |
| Location in tree | `packages/workspace/src/extensions/materializer/markdown/` | Parallel to `extensions/persistence/` and `extensions/sync/`. Materializers are a distinct concern (read-optimized projections, not state persistence). |
| Frontmatter library | None. Hand-roll YAML serialize | Frontmatter is simple key-value pairs. Avoids a dependency. The old extension used arktype for parsing. |
| Bidirectional sync | Deferred to Phase 2 | Can graft the old extension's sync coordination pattern (counter guards) when needed |

## Architecture

```
createWorkspace(definition)
  .withExtension('persistence', filesystemPersistence(...))    // Phase 0: Y.Doc state
  .withExtension('markdown', markdownMaterializer({            // Phase 1: Read projection
      directory: './data',
      tables: {
        savedTabs: { serializer: titleFilenameSerializer('title') },
        bookmarks: { serializer: titleFilenameSerializer('title') },
      },
    }))
  .withExtension('sync', createSyncExtension(...))             // Phase 0: Remote sync
```

Data flow (Phase 1. One-way):

```
Y.Doc (CRDT source of truth)
  │
  ├── table.observe('savedTabs') ──► write/delete .md files
  ├── table.observe('bookmarks') ──► write/delete .md files
  └── table.observe('devices')   ──► write/delete .md files
```

File structure:

```
{directory}/
├── savedTabs/
│   ├── github-pr-review-abc123.md
│   └── stack-overflow-question-def456.md
├── bookmarks/
│   ├── react-docs-ghi789.md
│   └── tailwind-css-jkl012.md
└── devices/
    └── chrome-on-macos-device_xyz.md
```

### Serializer API

```typescript
type MarkdownSerializer<TRow> = {
  /** Convert a row to markdown file content and filename */
  serialize(row: TRow): { frontmatter: Record<string, unknown>; body?: string; filename: string };
  /** Extract the row ID from a filename (needed for rename detection) */
  parseId(filename: string): string | null;
};

// Factory: all fields in frontmatter, {id}.md filename
function defaultSerializer(): MarkdownSerializer<any>;

// Factory: one field becomes the markdown body
function bodyFieldSerializer(fieldName: string): MarkdownSerializer<any>;

// Factory: human-readable {slugified-title}-{id}.md filenames
function titleFilenameSerializer(fieldName: string): MarkdownSerializer<any>;
```

### Extension Factory Signature

```typescript
type MarkdownMaterializerConfig = {
  /** Root directory for markdown output */
  directory: string;
  /** Per-table overrides. Tables not listed use defaultSerializer(). */
  tables?: Record<string, {
    /** Subdirectory name (defaults to table name) */
    directory?: string;
    /** Custom serializer (defaults to defaultSerializer()) */
    serializer?: MarkdownSerializer<any>;
  }>;
};

function markdownMaterializer(config: MarkdownMaterializerConfig): ExtensionFactory;
```

## Implementation Plan

### Phase 1: One-Way Materializer (Y.Doc → Files)

- [x] **1.1** Create `packages/workspace/src/extensions/materializer/markdown/` directory structure
- [x] **1.2** Implement `io.ts`: `writeMarkdownFile(path, frontmatter, body?)` and `deleteMarkdownFile(path)`. YAML frontmatter serialization (hand-rolled, no library). Use `Bun.write` for atomic writes.
- [x] **1.3** Implement `serializers.ts`: `defaultSerializer()`, `bodyFieldSerializer(field)`, `titleFilenameSerializer(field)` factories. Port the slugify logic from the old `configs.ts` (it used `filenamify`).
  > **Note**: Hand-rolled slugify instead of `filenamify` dependency (lowercase, replace non-alphanumeric, collapse dashes, truncate to 50 chars).
- [x] **1.4** Implement `markdown.ts`: the core extension factory. On `whenReady`: mkdir for each table directory, do initial full materialization (write all current valid rows). Subscribe to `table.observe()` for each table. On change: serialize and write/delete. Track filename map for rename detection (old filename delete + new filename write).
  > **Note**: Used `withWorkspaceExtension` (not `withExtension`) because the factory needs `tables` from `ExtensionContext`. The `table.observe()` callback receives `ReadonlySet<id>` (not `Map<id, action>` as originally described): determine add/update/delete by calling `table.get(id)` and checking `status`.
- [x] **1.5** Implement `index.ts`: public exports for the extension factory and serializer factories.
- [x] **1.6** Add subpath export to `packages/workspace/package.json`: `"./extensions/materializer/markdown"`.
- [x] **1.7** Wire into E2E config: update `playground/tab-manager-e2e/epicenter.config.ts` to include the markdown materializer.
- [ ] **1.8** Test: run `epicenter start playground/tab-manager-e2e`, verify `.md` files appear, modify data via the extension, verify files update.

### Phase 2: Bidirectional Sync (Future)

- [ ] **2.1** Add chokidar file watcher for `.md` file changes
- [ ] **2.2** Port sync coordination counters from the old extension (counter-based guards, not booleans)
- [ ] **2.3** Implement granular diff application (character-level for text, element-level for arrays)
- [ ] **2.4** Add diagnostics manager (real-time error tracking JSON)
- [ ] **2.5** Add error logger (append-only historical log)

### Phase 3: SQLite Materializer (Future)

- [ ] **3.1** Restore a Drizzle-based SQLite materializer as a separate extension under `extensions/materializer/sqlite/`
- [ ] **3.2** This would replace the deleted `extensions/sqlite/` but built against the Static API

## Edge Cases

### Row with no title field and titleFilenameSerializer

The serializer should fall back to `{id}.md` if the specified field is empty, undefined, or missing. The old extension handled this with a `filenamify` call that degrades gracefully.

### Encrypted rows before keys are applied

If the materializer runs before `applyEncryptionKeys()`, `getAllValid()` returns empty (encrypted rows fail validation). Once keys are applied, the materializer should re-run initial materialization. This can be handled by observing key application events or by having the materializer re-scan on the first successful `getAllValid()` that returns rows.

### Concurrent writes from observer batches

`table.observe()` fires once per Y.Transaction with a `Map` of all changes. The materializer should process the entire batch before yielding. No interleaving with other transactions.

### Filename collisions from slugification

Two rows with title "React Docs" produce the same slug. The `{slug}-{id}.md` pattern (from `titleFilenameSerializer`) avoids this because the ID suffix is unique.

### Large tables (>10k rows)

Initial materialization writes every row. For very large tables, this could be slow. Not a concern for tab-manager (hundreds of rows at most), but worth noting for future consumers.

## Open Questions

1. **Should tables not listed in `config.tables` be materialized with the default serializer, or skipped?**
   - Option A: Materialize all tables by default, `config.tables` provides overrides
   - Option B: Only materialize tables explicitly listed in `config.tables`
   - **Recommendation**: Option B (explicit). Materializing everything by default could produce unexpected files. Let the user opt in per table.

2. **Should we add `filenamify` as a dependency or hand-roll slug generation?**
   - The old extension used `filenamify` (npm package). It handles edge cases like reserved Windows filenames, control characters, etc.
   - **Recommendation**: Use `filenamify`. It's tiny, well-tested, and the edge cases are real.

3. **Where should the markdown output directory default to?**
   - Option A: Relative to `epicenter.config.ts` (e.g., `./data/`)
   - Option B: Inside `.epicenter/` (e.g., `.epicenter/materializer/markdown/`)
   - **Recommendation**: Option A. The whole point is human-readable files you can browse and git-track. Burying them in `.epicenter/` defeats the purpose.

4. **Should the extension handle `dispose()` by deleting materialized files?**
   - Option A: Delete all `.md` files on dispose (clean shutdown)
   - Option B: Leave files on disk (they're a cache/projection, not authoritative)
   - **Recommendation**: Option B. Files are useful even after the daemon stops. They're a snapshot of the last known state.

## Success Criteria

- [ ] `markdownMaterializer` extension factory exists at `@epicenter/workspace/extensions/materializer/markdown`
- [ ] Three serializer factories: `defaultSerializer`, `bodyFieldSerializer`, `titleFilenameSerializer`
- [ ] E2E config (`playground/tab-manager-e2e`) wired with the materializer
- [ ] Running `epicenter start playground/tab-manager-e2e` produces `.md` files for saved tabs and bookmarks
- [ ] Modifying data (save a tab, add a bookmark) via the extension updates corresponding `.md` files
- [ ] Deleting a row removes the corresponding `.md` file
- [ ] Row renames (title change with `titleFilenameSerializer`) delete old file and create new one
- [ ] `bun typecheck` passes in `packages/workspace`

## References

- `packages/workspace/src/extensions/persistence/sqlite.ts`: Current extension pattern to follow (factory shape, `whenReady`/`dispose` contract)
- `packages/workspace/src/extensions/persistence/indexeddb.ts`: Simplest extension example
- `playground/tab-manager-e2e/epicenter.config.ts`: Where the materializer will be wired in
- `apps/tab-manager/src/lib/workspace/definition.ts`: Table schemas (savedTabs, bookmarks, devices, etc.)
- Git: `d2c5e087^:packages/epicenter/src/extensions/markdown/`: The deleted extension (reference for serializer patterns, sync coordination, IO)
- Git: `d2c5e087^:packages/epicenter/src/extensions/sqlite/`: The deleted SQLite materializer (reference for Phase 3)

## Review

**Completed**: 2026-04-04
**Branch**: save/rpc-disconnect-fix

### Summary

Built a one-way markdown materializer extension across 4 new files in `packages/workspace/src/extensions/materializer/markdown/`. The extension writes table rows to `.md` files with YAML frontmatter, tracks filenames for rename detection, and cleans up observers on dispose. Wired into the tab-manager E2E config with `titleFilenameSerializer` for savedTabs/bookmarks and `defaultSerializer` for devices.

### Deviations from Spec

- **`withWorkspaceExtension` instead of `withExtension`**: The spec described using `.withExtension()`, but the factory needs `tables` from `ExtensionContext`. `withExtension` only provides `SharedExtensionContext` (ydoc, awareness, whenReady). Changed to `.withWorkspaceExtension()` which provides the full context including tables.
- **Observer callback is `ReadonlySet<id>`, not `Map<id, action>`**: The spec described the observer as receiving a `Map<id, 'add' | 'update' | 'delete'>`. The actual API passes `ReadonlySet<id>` and the consumer determines the action by calling `table.get(id)` (status `not_found` = deleted, `valid` = add/update).
- **Hand-rolled slugify instead of `filenamify`**: The spec recommended using `filenamify` as a dependency. The handoff explicitly prohibited new dependencies, so slugify is hand-rolled (lowercase, replace non-alphanumeric, collapse dashes, truncate to 50 chars).
- **`config.tables` is required, not optional**: The spec typed `tables?` as optional with a recommendation for explicit opt-in. Made it required (`tables: Record<...>`) since the handoff spec resolved this as explicit opt-in only.

### Follow-up Work

- **1.8**: Manual E2E test (`epicenter start playground/tab-manager-e2e`) to verify files appear and update
- **Phase 2**: Bidirectional sync (chokidar, sync coordination counters, granular diffs)
- **Phase 3**: SQLite materializer as a separate extension
