# Simplify Path Configuration with IndexContext

## Problem

Current API is verbose and requires users to configure paths everywhere:

```typescript
// Current: verbose path configuration
indexes: {
  sqlite: (db) => sqliteIndex(db, {
    path: path.join(import.meta.dirname, '.epicenter/database.db')
  }),
  markdown: (db) => markdownIndex(db, {
    rootPath: path.join(import.meta.dirname, './content'),
    // ...
  }),
}

providers: [
  setupPersistence({
    storagePath: path.join(import.meta.dirname, '.epicenter')
  })
]
```

## Solution

1. **Standardize on `.epicenter` directory** - all persistence and SQLite data goes here by default
2. **Introduce `IndexContext`** - similar to `ProviderContext`, provides workspace metadata to indexes
3. **Remove path configuration** - SQLite and persistence auto-resolve paths using workspace ID
4. **Simplify Markdown** - only `rootPath` is configurable, relative to config file by default

## Desired API

```typescript
// New: clean, minimal configuration
indexes: {
  sqlite: sqliteIndex,  // Auto-saves to .epicenter/{workspaceId}.db
  markdown: ({ id, db }) => markdownIndex({
    id,
    db,
    rootPath: './content',  // Relative to epicenter.config.ts
    // ...
  }),
}

providers: [
  setupPersistence()  // Auto-saves to .epicenter/{workspaceId}.yjs
]
```

## Implementation Plan

### 1. Update `ProviderContext`

Add `id` field so providers know the workspace ID without accessing `ydoc.guid`:

```typescript
// packages/epicenter/src/core/workspace/config.ts
export type ProviderContext = {
  id: string;  // NEW: workspace ID
  ydoc: Y.Doc;
};
```

### 2. Create `IndexContext`

Similar to `ProviderContext`, provides workspace metadata to indexes:

```typescript
// packages/epicenter/src/core/indexes/index.ts
export type IndexContext<TSchema extends WorkspaceSchema> = {
  id: string;  // Workspace ID
  db: Db<TSchema>;  // Epicenter database instance
};
```

### 3. Update Workspace Config

Change index functions to receive `IndexContext`:

```typescript
// Before
indexes: {
  [K in keyof TIndexResults]: (
    db: Db<TWorkspaceSchema>,
  ) => TIndexResults[K] | Promise<TIndexResults[K]>;
};

// After
indexes: {
  [K in keyof TIndexResults]: (
    context: IndexContext<TWorkspaceSchema>,
  ) => TIndexResults[K] | Promise<TIndexResults[K]>;
};
```

### 4. Update Workspace Client Initialization

Pass `IndexContext` when calling index functions using Object.fromEntries:

```typescript
// In initializeWorkspaces()
const indexResults = Object.fromEntries(
  await Promise.all(
    Object.entries(config.indexes).map(async ([indexName, indexFn]) => [
      indexName,
      await indexFn({
        id: config.id,  // NEW: pass workspace ID
        db
      })
    ])
  )
);
```

### 5. Refactor `sqliteIndex`

Remove path configuration, auto-resolve to `.epicenter/{id}.db`:

```typescript
// Before
export async function sqliteIndex<TSchema extends WorkspaceSchema>(
  db: Db<TSchema>,
  config: SQLiteIndexConfig = {},
)

// After
export async function sqliteIndex<TSchema extends WorkspaceSchema>(
  { id, db }: IndexContext<TSchema>,
) {
  // Auto-resolve path to .epicenter/{id}.db
  const resolvedDatabasePath = path.join('.epicenter', `${id}.db`);

  // Create parent directory if it doesn't exist
  await mkdir('.epicenter', { recursive: true });

  // Rest of implementation...
}
```

### 6. Refactor `markdownIndex`

Use `IndexContext` and document `rootPath` as config-relative:

```typescript
// Before
export function markdownIndex<TSchema extends WorkspaceSchema>(
  db: Db<TSchema>,
  config: MarkdownIndexConfig<TSchema>,
)

// After
export function markdownIndex<TSchema extends WorkspaceSchema>({
  id,
  db,
  rootPath,
  pathToTableAndId,
  tableAndIdToPath,
  serializers = {},
}: IndexContext<TSchema> & MarkdownIndexConfig<TSchema>) {
  // rootPath is relative to epicenter.config.ts by default
  // Users can also use path.join(import.meta.dirname, ...) for explicit control
  // Or provide absolute paths

  // Rest of implementation...
}
```

Update JSDoc:

```typescript
/**
 * Absolute or relative root path where markdown files should be stored.
 *
 * **Relative paths** (recommended): Resolved relative to epicenter.config.ts location
 * ```typescript
 * rootPath: './content'  // → <config-dir>/content
 * rootPath: '../vault'   // → <config-dir>/../vault
 * ```
 *
 * **Absolute paths**: Used as-is
 * ```typescript
 * rootPath: '/absolute/path/to/vault'
 * ```
 *
 * **Explicit control**: Use import.meta.dirname if needed
 * ```typescript
 * rootPath: path.join(import.meta.dirname, './vault')
 * ```
 */
rootPath: string;
```

### 7. Refactor `setupPersistence`

Remove `storagePath` parameter, auto-resolve to `.epicenter/{id}.yjs`:

```typescript
// Before
export function setupPersistence(options: SetupPersistenceOptions) {
  return async ({ ydoc }: ProviderContext): Promise<void> => {
    const { storagePath } = options;
    const filePath = path.join(storagePath, `${ydoc.guid}.yjs`);
    // ...
  };
}

// After
export function setupPersistence() {
  return async ({ id, ydoc }: ProviderContext): Promise<void> => {
    // Auto-resolve to .epicenter/{id}.yjs
    const storagePath = '.epicenter';
    const filePath = path.join(storagePath, `${id}.yjs`);

    // Ensure storage directory exists
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    // Rest of implementation...
  };
}
```

## Migration Guide

### Before (Verbose)

```typescript
import path from 'node:path';

const workspace = defineWorkspace({
  id: 'blog',

  indexes: {
    sqlite: (db) => sqliteIndex(db, {
      path: path.join(import.meta.dirname, '.epicenter/blog.db')
    }),
    markdown: (db) => markdownIndex(db, {
      rootPath: path.join(import.meta.dirname, './content'),
      // ...
    }),
  },

  providers: [
    setupPersistence({
      storagePath: path.join(import.meta.dirname, '.epicenter')
    })
  ],
});
```

### After (Clean)

```typescript
const workspace = defineWorkspace({
  id: 'blog',

  indexes: {
    sqlite: sqliteIndex,  // ← Just the function!
    markdown: ({ id, db }) => markdownIndex({
      id,
      db,
      rootPath: './content',  // ← Relative to config file
      // ...
    }),
  },

  providers: [
    setupPersistence()  // ← No config needed!
  ],
});
```

## Todo List

- [x] Update `ProviderContext` type to include `id` field
- [x] Create `IndexContext` type
- [x] Update workspace config types to use `IndexContext`
- [x] Update `initializeWorkspaces` to pass `IndexContext` to index functions
- [x] Update `initializeWorkspaces` to pass `id` to `ProviderContext`
- [x] Refactor `sqliteIndex` to use `IndexContext` and remove path config
- [x] Refactor `markdownIndex` to use `IndexContext`
- [x] Update `markdownIndex` JSDoc to clarify rootPath resolution
- [x] Refactor `setupPersistence` to remove `storagePath` parameter
- [x] Update all examples (basic-workspace, content-hub workspaces)
- [ ] Update main README with new simplified API
- [ ] Update index-specific documentation

## Review

### Completed Changes

All implementation tasks have been completed successfully. The refactoring involved:

**Core Type Changes:**
1. Added `id: string` to `ProviderContext` in `src/core/workspace/config.ts:23-26`
2. Created `IndexContext<TSchema>` type with `id` and `db` fields in `src/core/indexes.ts:60-63`
3. Renamed types for consistency with Provider pattern:
   - `Index` → `IndexExports` (the result object with destroy method)
   - `IndexFactory` → `Index` (the function that creates an index)
   - `defineIndex` → `defineIndexExports` (helper function)

**Implementation Updates:**
4. Updated `initializeWorkspaces` in `src/core/workspace/client.ts` to:
   - Pass `{ id, ydoc }` to providers instead of just `{ ydoc }`
   - Pass `{ id, db }` to index functions using Object.fromEntries pattern
5. Refactored `sqliteIndex` in `src/indexes/sqlite/index.ts:50-185`:
   - Changed signature to destructure `{ id, db }` from IndexContext
   - Removed SQLiteIndexConfig type (no longer needed)
   - Auto-resolves database path to `.epicenter/{id}.db`
   - Creates `.epicenter` directory if it doesn't exist
6. Refactored `markdownIndex` in `src/indexes/markdown/index.ts`:
   - Changed signature to destructure all params including `{ id, db }`
   - Updated JSDoc to explain relative path resolution (relative to config file)
7. Refactored `setupPersistence` in `src/core/workspace/providers/persistence/desktop.ts`:
   - Removed SetupPersistenceOptions type
   - Changed to take no parameters
   - Auto-resolves storage path to `.epicenter/{id}.yjs`
   - Uses `id` from ProviderContext instead of `ydoc.guid`

**Example Updates:**
8. Updated `examples/basic-workspace/epicenter.config.ts`:
   - Simplified sqlite from `(db) => sqliteIndex(db)` to just `sqliteIndex`
   - Updated markdown to destructure `{ id, db }` in signature
   - Simplified setupPersistence from `setupPersistence({ storagePath: ... })` to `setupPersistence()`
9. Updated all 14 content-hub workspace files:
   - `workspace.medium.ts`
   - `workspace.youtube.ts`
   - `workspace.github-issues.ts`
   - `workspace.instagram.ts`
   - `workspace.discord.ts`
   - `workspace.producthunt.ts`
   - `workspace.pages.ts`
   - `workspace.personal-blog.ts`
   - `workspace.bookface.ts`
   - `workspace.twitter.ts`
   - `workspace.hackernews.ts`
   - `workspace.epicenter-blog.ts`
   - `workspace.tiktok.ts`
   - `workspace.reddit.ts`
   - `workspace.substack.ts`

All files now use the simplified API with auto-resolved paths.

### API Improvements

**Before (Verbose):**
```typescript
import path from 'node:path';

indexes: {
  sqlite: (db) => sqliteIndex(db, {
    path: path.join('.epicenter', 'workspace.db'),
  }),
  markdown: (db) => markdownIndex(db, {
    rootPath: path.join(import.meta.dirname, './content'),
    // ...
  }),
},
providers: [
  setupPersistence({
    storagePath: './.epicenter',
  }),
],
```

**After (Clean):**
```typescript
indexes: {
  sqlite: sqliteIndex,
  markdown: ({ id, db }) => markdownIndex({
    id,
    db,
    rootPath: './content',
    // ...
  }),
},
providers: [setupPersistence()],
```

### Benefits

1. **Less boilerplate**: No need to import `path` module for most use cases
2. **Consistent conventions**: All persistence data goes to `.epicenter/` directory
3. **Automatic path resolution**: SQLite and YJS files use workspace ID for naming
4. **Better DX**: Users can just write `sqlite: sqliteIndex` instead of wrapping it
5. **Type safety**: IndexContext provides strong typing for index functions
6. **Consistency**: Follows the same pattern as ProviderContext

### Outstanding Work

- Documentation updates for README and index-specific docs
- These can be addressed in a follow-up if needed
