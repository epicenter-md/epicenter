# SQLite Config Control Inversion

## Overview
Refactor the SQLite persister to accept configuration from callers (similar to the persistence provider pattern) instead of managing its own path construction. This makes the persister more reusable and testable while keeping concerns properly separated.

## Goals
- Invert control: callers pass in the path, SQLite persister just uses it
- Simplify the config: optional `path` field where presence acts as the discriminator
- Set sensible defaults inside the persister (WAL mode on, foreign keys off)
- Apply the same pattern across all SQLite instantiation sites

## Design

### SQLite Config Type
```typescript
type SQLiteIndexConfig = {
  /**
   * Path to the SQLite database file.
   * If provided, uses file-based storage at this path.
   * If not provided, uses in-memory storage (useful for testing).
   */
  path?: string;
}
```

The `path` field acts as the discriminator:
- If `path` is provided: file-based mode
- If `path` is undefined: in-memory mode

### SQLite Persister Defaults
- WAL mode: enabled
- Foreign keys: disabled (SQLite is used as read-only index for indexing)

### Caller Pattern
For file-based storage:
```typescript
sqliteIndex(db, {
  path: join(import.meta.dirname, '.epicenter/database.db')
})
```

For in-memory storage (testing):
```typescript
sqliteIndex(db)
// or
sqliteIndex(db, {})
```

## Tasks

- [ ] Update SQLite config type definition in `packages/epicenter/src/indexes/sqlite/index.ts`
- [ ] Update SQLite persister to accept the new config type
- [ ] Add default WAL mode and foreign keys pragmas inside persister
- [ ] Update persistence provider to follow same pattern (pass in path via config)
- [ ] Update all SQLite instantiation sites to construct and pass config
  - [ ] Content Hub hackernews example
  - [ ] Other examples that use SQLite
- [ ] Test changes in content-hub example
- [ ] Verify database creation and isolation per workspace

## Review

### Changes Made

1. **SQLite Config Type (index.ts:20-33)**
   - Simplified from discriminated union to a single object with optional `path` field
   - Type: `{ path?: string }`
   - `path` presence acts as the discriminator: present = file mode, absent = in-memory mode
   - Added comprehensive JSDoc explaining the behavior and usage pattern

2. **SQLite Persister Implementation (index.ts:75-99)**
   - Updated function signature: `sqliteIndex(db, config = {})` now accepts optional config
   - Simplified logic: `if (config.path)` instead of checking a mode field
   - Inverted control: path construction is now the caller's responsibility
   - Added WAL mode by default via `client.exec('PRAGMA journal_mode = WAL')`
   - Directory creation extracts parent path and creates it if needed

3. **Updated All Workspace Configs**
   - 9 files updated across content-hub examples (hackernews, instagram, tiktok, epicenter-blog, github-issues, reddit, bookface, youtube, mcp.test.ts)
   - Changed all imports from `import path from 'node:path'` to `import { join } from 'node:path'` for consistency
   - Simplified from `{ mode: 'file', path: ... }` to just `{ path: ... }`
   - All now pass: `sqliteIndex(db, { path: join(import.meta.dirname, '.epicenter/database.db') })`

4. **Removed Unused Import**
   - Removed `EPICENTER_STORAGE_DIR` import from persistence module (no longer needed)

### Result

Each workspace has its own isolated database at `.epicenter/database.db` relative to its config file. The SQLite persister:
- Has WAL mode enabled by default
- No longer needs to know about application structure
- Can be instantiated with either in-memory (testing) or file-based (production) storage
- Is testable and reusable across different contexts
- Simpler API: just pass `{ path: ... }` when you need file storage

The pattern mirrors the persistence provider approach, making the codebase more consistent. The optional `path` field is cleaner than an explicit `mode` field.
