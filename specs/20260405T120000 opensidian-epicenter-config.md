# Opensidian `epicenter.config.ts`

## Goal

Create an `epicenter.config.ts` for the Opensidian app that enables one-way persistence from the Epicenter cloud to local disk. Including document content. Following the pattern established by `playground/tab-manager-e2e/epicenter.config.ts`.

## Context

Opensidian is a note-taking app with one table (`files` from `@epicenter/filesystem`) and per-row document content via `.withDocument('content')`. The `files` table stores metadata (name, parentId, type, size, timestamps). Document content lives in separate Y.Docs accessed via `workspace.documents.files.content`.

### Reference: tab-manager-e2e config

```
playground/tab-manager-e2e/epicenter.config.ts
├── filesystemPersistence (single .db file)
├── markdownMaterializer  (metadata-only frontmatter)
├── encryption unlock     (from CLI session store)
└── sync extension        (WebSocket to API)
```

### Why Opensidian differs

The standard `markdownMaterializer`'s serializer only receives table row data. It can't access document content (which lives in separate Y.Docs via `.withDocument('content')`). We need a custom materializer that uses `withWorkspaceExtension` to access `documents.files.content.open(id)` → `handle.read()`.

## Design

### Workspace-only persistence

Single SQLite file for the workspace Y.Doc (files table metadata). Content docs rely on sync. No per-doc SQLite. This keeps things simple while ensuring the files table survives daemon restarts and works offline.

```typescript
.withWorkspaceExtension('persistence', (ctx) =>
    persistence(ctx, { filePath: join(PERSISTENCE_DIR, 'opensidian.db') })
)
```

### Content materializer

A custom one-way `withWorkspaceExtension` that writes `.md` files with frontmatter (file metadata) + body (document content). Same pattern as the existing `markdownMaterializer` but enhanced with document handle reads.

1. Waits for prior extensions to be ready
2. Materializes all files: frontmatter (metadata) + body (document content via `handle.read()`)
3. Observes table changes and re-materializes (document content changes trigger `updatedAt` via `onUpdate`, which fires the table observer)
4. Handles file deletion and rename detection
5. Skips folders (only materializes `type === 'file'`)

Files written to `data/files/` as `{slugified-name}-{id}.md`.

### Sync timing

On first run (no local data):
1. Persistence loads (empty)
2. Sync connects, downloads workspace state
3. Table observer fires as files arrive
4. For each file, `documents.files.content.open(id)` fetches content via sync
5. Files materialize as content becomes available

Initial materialization may write files with empty content; subsequent observer callbacks re-write as content syncs in.

## File structure

```
playground/opensidian-e2e/
├── epicenter.config.ts          ← NEW
└── README.md                    ← NEW

packages/cli/
├── src/README.md                ← UPDATED (playground configs section)
└── test/
    └── e2e-opensidian.test.ts   ← NEW
```

## Todo

- [x] Create `playground/opensidian-e2e/epicenter.config.ts` with workspace persistence, content materializer, encryption unlock, and sync
- [x] Create `playground/opensidian-e2e/README.md` with usage guide
- [x] Create `packages/cli/test/e2e-opensidian.test.ts` with config loading, table CRUD, document content, and persistence survival tests
- [x] Update `packages/cli/src/README.md` with playground configs section
- [x] Verify the config loads via `loadConfig()`: discovers 1 client with ID `opensidian`
- [x] All 13 e2e tests pass (honeycrisp + tab-manager + opensidian)

## Review

### Changes made

**`playground/opensidian-e2e/epicenter.config.ts`** (new, 196 lines)
- Workspace-only persistence via `withWorkspaceExtension` + `persistence()`: single SQLite file at `.epicenter/persistence/opensidian.db`
- Custom one-way content materializer via `withWorkspaceExtension('markdown', ...)` that:
  - Reads document content via `documents.files.content.open(id)` → `handle.read()`
  - Writes `.md` files with YAML frontmatter (file metadata) + markdown body (document content)
  - Observes the files table for changes (document content changes trigger `updatedAt` via `onUpdate`)
  - Handles rename detection and file deletion
  - Skips folders (only materializes `type === 'file'`)
- Encryption unlock from CLI session store (standard pattern)
- Sync extension for WebSocket sync to Epicenter API (standard pattern)

**`packages/cli/test/e2e-opensidian.test.ts`** (new, 129 lines)
- Workspace ID assertion
- Table CRUD: create folder + file, verify metadata
- Document content: write + read round-trip
- Persistence survival: table data persists across client restart
- All 4 tests pass (562ms)

### Design decisions

1. **Workspace-only persistence**: content docs rely on sync, not local SQLite. Keeps the config simple. The workspace persistence ensures the files table survives daemon restarts.
2. **Custom materializer over standard `markdownMaterializer`**: the standard serializer only receives table row data and can't access document content (separate Y.Docs via `.withDocument('content')`). The custom extension uses `ExtensionContext.documents` to read content.
3. **`slugify` + `filenamify` for filenames**: matches the `titleFilenameSerializer` pattern from the workspace package. Falls back to `{id}.md` for empty names.
4. **Graceful content fallback**: if document content isn't yet available (sync pending), the materializer writes metadata-only `.md` files. Subsequent observer callbacks fill in content as it arrives.
5. **Config lives in `playground/`, not `apps/`**: the config is a CLI/daemon artifact that runs under `bun` via `epicenter start`. Putting it inside the SvelteKit app would pull it into Vite's module graph. The `playground/` pattern (established by `tab-manager-e2e`) keeps configs as standalone projects that consume workspace packages.
