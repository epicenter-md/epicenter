# Subpath Exports for @epicenter/HQ

## Context

The `packages/epicenter` package is currently exporting everything from a single barrel export (`./src/index.ts`), but we have code in other packages (like `EpicenterHQ/workspaces`) that needs to import specific modules that aren't currently exported properly.

Current issues:
1. Code in `EpicenterHQ/workspaces/email.ts` uses relative imports (`../../../packages/epicenter/src/core/schema`) that don't work
2. Some utilities like `isDateWithTimezoneString` and `MarkdownIndexErr` aren't exported from the main barrel
3. The package would benefit from organized subpath exports for better tree-shaking and clearer API surface

## Analysis

Looking at the codebase structure, I see several distinct modules:

1. **Core exports** (already in main barrel): workspace, schema, actions, epicenter, db
2. **Index implementations**: markdown, sqlite (partially exported)
3. **Providers**: persistence, hocuspocus (already has `/providers` subpath)
4. **Platform-specific**: cli, desktop, web (already have subpaths)
5. **Server**: REST API and MCP server (already has subpath indirectly)
6. **Missing exports**: Helper functions, error types from index implementations

## Decision: Clear Separation by Purpose

**Main barrel (`@epicenter/hq`)**: Export everything from `core/`
- All core functionality (workspace, schema, actions, epicenter, db, errors)
- Everything needed to define and use workspaces
- Principle: If it's in `core/`, it's fundamental API

**Subpath exports**:
- Index-specific implementations: `/indexes/markdown`, `/indexes/sqlite`
- Platform-specific: `/cli`, `/desktop`, `/web` (already done)
- Server infrastructure: `/server` (REST/MCP, not core)
- Providers: `/providers` (already done)

**Directory reorganization:**
- Move `src/db/` → `src/core/db/` (database is core infrastructure)
- Move `src/utils/` → `src/core/utils/` (YJS utilities used by core)
- Delete `src/types/drizzle-helpers.ts` (unused, no imports)
- Keep `src/server/` separate (deployment concern, not core API)
- Keep `src/indexes/` separate (implementation details)

### Why This Approach?

1. **Simple mental model**: `core/` = main barrel, everything else = subpaths
2. **Core is complete**: Everything fundamental is in one import
3. **Indexes are opt-in**: Only import index utilities when customizing serializers
4. **Clean boundaries**: Directory structure = export structure
5. **Server is infrastructure**: Not part of workspace definition API

## Implementation Plan

### Todo List

- [ ] Move `src/db/` to `src/core/db/` (it's fundamental to core)
- [ ] Move `src/utils/` to `src/core/utils/` (YJS utilities used by core)
- [ ] Delete unused `src/types/drizzle-helpers.ts` (no imports found)
- [ ] Update all imports after directory moves
- [ ] Export `isDateWithTimezoneString` from main barrel (already in core/schema)
- [ ] Create `/indexes/markdown` subpath export for `MarkdownIndexErr` and utilities
- [ ] Create `/indexes/sqlite` subpath export for sqlite-specific utilities
- [ ] Update `package.json` with new subpath exports
- [ ] Update `EpicenterHQ/workspaces/email.ts` to use new exports
- [ ] Verify all imports work correctly

## Proposed Export Structure

```typescript
// @epicenter/hq (main barrel - everything in core/)
- Workspace: defineWorkspace, createWorkspaceClient
- Epicenter: defineEpicenter, createEpicenterClient
- Schema: id, text, date, ytext, boolean, etc.
- Schema utilities: isDateWithTimezoneString, generateId, validateRow, etc.
- Actions: defineQuery, defineMutation
- Database: createEpicenterDb, TableHelper, Db types
- Indexes: defineIndexExports, Index types, markdownIndex, sqliteIndex
- Errors: IndexErr, EpicenterOperationError, IndexError
- Drizzle re-exports: eq, ne, gt, lt, and, or, sql, etc.

// @epicenter/hq/indexes/markdown (markdown index utilities)
- MarkdownIndexErr, MarkdownIndexError
- MarkdownIndexConfig type
- Helper functions for custom serializers/deserializers

// @epicenter/hq/indexes/sqlite (sqlite index utilities)
- SQLite-specific types and utilities (if any)
- Custom query helpers (if any)

// @epicenter/hq/providers (already exists)
- setupPersistence

// @epicenter/hq/cli (already exists)
// @epicenter/hq/desktop (already exists)
// @epicenter/hq/web (already exists)
```

## Changes Required

### 0. Directory reorganization

**Move directories:**
```bash
mv src/db src/core/db
mv src/utils src/core/utils
```

**Delete unused file:**
```bash
rm src/types/drizzle-helpers.ts
```

**Update imports:**
- In `src/core/schema.ts`: change `../utils/yjs` to `./utils/yjs`
- In `src/core/db/table-helper.ts`: change `../utils/yjs` to `../utils/yjs`
- In `src/core/indexes.ts`: change `../db/core` to `./db/core`
- In `src/indexes/markdown/index.ts`: change `../../db/core` to `../../core/db/core`
- In `src/indexes/sqlite/index.ts`: change `../../db/core` to `../../core/db/core` (if exists)

### 1. Update main barrel export (`src/index.ts`)

Add missing exports from core:
```typescript
// Add to existing schema exports
export { isDateWithTimezoneString } from './core/schema';
```

### 2. Create markdown index subpath export

New file: `src/indexes/markdown/exports.ts`
```typescript
export { MarkdownIndexErr, MarkdownIndexError } from './index';
export type { MarkdownIndexConfig } from './index';
// Export any other markdown-specific utilities
```

### 3. Create sqlite index subpath export

New file: `src/indexes/sqlite/exports.ts`
```typescript
// Export any sqlite-specific utilities that users might need
// Check if there are custom builders or helpers to export
export type { /* sqlite-specific types */ } from './index';
```

### 4. Update `package.json` exports

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./cli": "./src/cli/index.ts",
    "./desktop": "./src/desktop/index.ts",
    "./web": "./src/web/index.ts",
    "./providers": "./src/core/workspace/providers/index.ts",
    "./indexes/markdown": "./src/indexes/markdown/exports.ts",
    "./indexes/sqlite": "./src/indexes/sqlite/exports.ts"
  }
}
```

### 5. Update consumer code

Update `EpicenterHQ/workspaces/email.ts`:
```typescript
// Before:
import { isDateWithTimezoneString } from '../../../packages/epicenter/src/core/schema';
import { MarkdownIndexErr } from '../../../packages/epicenter/src/indexes/markdown';

// After:
import { isDateWithTimezoneString } from '@epicenter/hq';
import { MarkdownIndexErr } from '@epicenter/hq/indexes/markdown';
```

## Alternative: Everything in Main Barrel

If we wanted to avoid subpath exports entirely, we could just export everything from the main barrel:

```typescript
// src/index.ts
export { isDateWithTimezoneString } from './core/schema';
export { MarkdownIndexErr, MarkdownIndexError } from './indexes/markdown';
export type { MarkdownIndexConfig } from './indexes/markdown';
```

Then consumers would import:
```typescript
import { isDateWithTimezoneString, MarkdownIndexErr } from '@epicenter/hq';
```

**Downsides**:
- Larger bundle size for users who don't need these utilities
- Less clear what's "core API" vs "advanced utilities"
- Potential naming conflicts as package grows

**Upsides**:
- Simpler imports
- Single source of truth
- Easier to use

## Recommendation

This approach provides:
1. **Clear mental model**: Everything in `core/` directory = everything in main barrel
2. **Simple imports**: Core functionality is all `@epicenter/hq`
3. **Index utilities isolated**: Advanced customization uses `@epicenter/hq/indexes/*`
4. **Natural boundaries**: File structure matches export structure
5. **Consistency**: Follows pattern already established with platform exports

The key insight: `core/` contains the fundamental API, `indexes/` contains implementation details that are only needed when building custom serializers or doing advanced queries.

## Review

### Changes Completed

**Directory Reorganization:**
- ✅ Moved `src/db/` → `src/core/db/` (database is core infrastructure)
- ✅ Moved `src/utils/` → `src/core/utils/` (YJS utilities used by core)
- ✅ Deleted `src/types/drizzle-helpers.ts` (unused file with no imports)

**Import Updates:**
- ✅ Updated all imports in `core/` modules to use relative paths (`./db`, `./utils`)
- ✅ Updated imports in `indexes/` modules to use `../../core/db/core`
- ✅ Updated main barrel export to use `./core/db/core`
- ✅ Fixed test file imports in `core/db/` directory

**Export Structure:**
- ✅ Added `isDateWithTimezoneString` to main barrel export
- ✅ Created `src/indexes/markdown/exports.ts` with `MarkdownIndexErr` and `MarkdownIndexConfig`
- ✅ Created `src/indexes/sqlite/exports.ts` for consistency
- ✅ Updated `package.json` with new subpath exports

**Consumer Updates:**
- ✅ Updated `EpicenterHQ/workspaces/email.ts` to use new imports:
  - `isDateWithTimezoneString` from `@epicenter/hq`
  - `MarkdownIndexErr` from `@epicenter/hq/indexes/markdown`

**Verification:**
- ✅ Typecheck passes with no import errors (TS2307)
- ✅ All pre-existing tests and errors remain unchanged
- ✅ New directory structure is consistent and clean

### Final Structure

```
packages/epicenter/src/
├── core/
│   ├── db/              ← moved from src/db/
│   ├── utils/           ← moved from src/utils/
│   ├── schema.ts
│   ├── workspace/
│   ├── epicenter/
│   └── ...
├── indexes/
│   ├── markdown/
│   │   ├── index.ts
│   │   └── exports.ts   ← new
│   └── sqlite/
│       ├── index.ts
│       └── exports.ts   ← new
├── server/
├── cli/
├── desktop/
├── web/
└── index.ts
```

### Export Map

```typescript
@epicenter/hq                    // Everything in core/ (workspace, schema, db, etc.)
@epicenter/hq/indexes/markdown   // Markdown index utilities
@epicenter/hq/indexes/sqlite     // SQLite index utilities
@epicenter/hq/providers          // Provider utilities (already existed)
@epicenter/hq/cli                // CLI tools (already existed)
@epicenter/hq/desktop            // Desktop-specific (already existed)
@epicenter/hq/web                // Web-specific (already existed)
```

### Key Insights

1. **Simple mental model works**: `core/` = main barrel, everything else = subpaths
2. **Directory structure matches exports**: Easy to understand what's exported where
3. **Database and utils belong in core**: They're fundamental infrastructure
4. **Index utilities are opt-in**: Only needed for custom serializers
5. **Clean import paths**: No more `../../../packages/epicenter/src/...`
