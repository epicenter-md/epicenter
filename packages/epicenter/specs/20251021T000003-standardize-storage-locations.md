# Standardize Storage Locations

## Current State

Storage is inconsistent:
- YJS files: `.epicenter/{workspaceId}.yjs` (hardcoded)
- SQLite: `.data/{database}` (auto-prefixed, but examples show `.data/` in config)
- Markdown: User-configurable path (no convention)

## Desired State

**`.epicenter/` contains both YJS and SQLite:**
- YJS files: `.epicenter/{workspaceId}.yjs`
- SQLite databases: `.epicenter/{database}`

**Database config must be simple filenames:**
- Good: `database: 'blog.db'`
- Bad: `database: '.data/blog.db'` or `database: '/anything/blog.db'`

**Markdown remains user-configurable:**
- No standard location enforced
- User specifies full path in `rootDir`

## Changes Needed

### 1. Create Storage Directory Constant
- Create `EPICENTER_STORAGE_DIR = '.epicenter'` constant
- Export from appropriate location (maybe `src/core/constants.ts` or inline where used)
- Use this constant in both persistence and sqlite code

### 2. Update SQLite Index (src/indexes/sqlite/index.ts)
- Change auto-prefix from `.data/` to `.epicenter/` using constant
- Update documentation/comments
- Line ~197: Change `await mkdir('.data', ...)` to `await mkdir(EPICENTER_STORAGE_DIR, ...)`
- Line ~199: Change `resolvedDatabasePath = join('.data', database)` to `join(EPICENTER_STORAGE_DIR, database)`

### 3. Update Persistence (src/persistence/desktop.ts)
- Replace hardcoded `'./.epicenter'` string with constant
- Line ~69: Change `const rootDir = './.epicenter' as const;` to use constant

### 4. Fix All Database Configs
Find and fix all configs that use `database:` with paths:

**Examples:**
- `examples/basic-workspace/epicenter.config.ts`: `.data/blog.db` → `blog.db`
- `examples/e2e-tests/epicenter.config.ts`: `.data/blog.db` → `blog.db`
- `examples/content-hub/`: Find any database configs

**Tests:**
- Search for all `database:` in test files
- Ensure they're just filenames, not paths

### 5. Update Documentation
- Update JSDoc comments in `src/indexes/sqlite/index.ts`
- Change all `.data/` references to `.epicenter/`
- Update examples in comments

### 6. Clean Up Old .data Directories (optional)
- Could add migration note or just let users manually clean up

## Todo List

- [ ] Create EPICENTER_STORAGE_DIR constant
- [ ] Update sqlite/index.ts to use constant and `.epicenter/`
- [ ] Update persistence/desktop.ts to use constant
- [ ] Fix examples/basic-workspace/epicenter.config.ts database config
- [ ] Fix examples/e2e-tests/epicenter.config.ts database config
- [ ] Find and fix any other database configs in examples/
- [ ] Find and fix any database configs in tests
- [ ] Update JSDoc comments in sqlite/index.ts
- [ ] Run tests to verify everything works

## Implementation Notes

The change is straightforward:
1. SQLite code already validates that database names are simple filenames (no paths)
2. We're just changing which directory those files go into
3. Markdown index is unaffected (user already provides full path)

## Review

Successfully standardized storage locations:

**Changes Made:**
1. Created `EPICENTER_STORAGE_DIR = '.epicenter'` constant in:
   - `src/indexes/sqlite/index.ts`
   - `src/persistence/desktop.ts`

2. Updated SQLite index (`src/indexes/sqlite/index.ts`):
   - Changed directory from `.data/` to `.epicenter/`
   - Updated all documentation/comments to reference `.epicenter`
   - Used constant for directory references

3. Fixed database configs in examples (removed `.data/` prefix):
   - `examples/basic-workspace/epicenter.config.ts`: `.data/blog.db` → `blog.db`
   - `examples/e2e-tests/epicenter.config.ts`: `.data/blog.db` → `blog.db`
   - `examples/dependency-testing/users.ts`: `.data/users.db` → `users.db`
   - `examples/dependency-testing/comments.ts`: `.data/comments.db` → `comments.db`
   - `examples/dependency-testing/posts.ts`: `.data/posts.db` → `posts.db`
   - `examples/dependency-testing/analytics.ts`: `.data/analytics.db` → `analytics.db`

4. Test results:
   - Core workspace tests: 9 pass, 0 fail ✓
   - All database configs now use simple filenames
   - Old `.data/` directories can be manually cleaned up by users

**Final State:**
- `.epicenter/` now contains both YJS files and SQLite databases
- Database configs only accept simple filenames like `blog.db`
- Markdown storage remains user-configurable (no standard enforced)
- All examples updated to new pattern
