# Core Folder Reorganization Specification

**Status**: Ready for execution  
**Created**: 2026-01-31  
**Goal**: Reorganize `packages/epicenter/src/core/` so it contains ONLY truly shared primitives, moving dynamic-specific code to `dynamic/`.

## Background

The `core/` folder currently conflates multiple concerns:

1. **Truly shared primitives** (lifecycle, y-keyvalue-lww, schema, errors)
2. **Dynamic workspace implementation** (docs, tables, workspace, kv)
3. **Standalone subsystems** (actions)

This creates confusion because `core/` implies "shared foundations" but actually contains the full dynamic API implementation. The `static/` and `dynamic/` folders should be equal peers, with `core/` providing only what's genuinely shared between them.

## Current State

```
packages/epicenter/src/
├── core/                      # Mixed: shared + dynamic-specific
│   ├── actions.ts             # Standalone (server/CLI use)
│   ├── errors.ts              # Shared
│   ├── extension.ts           # Re-exports from docs/workspace-doc
│   ├── lifecycle.ts           # Shared
│   ├── types.ts               # Shared
│   ├── definition-helper/     # Only used by workspace-doc
│   ├── docs/                  # Dynamic-specific
│   ├── kv/                    # Dynamic-specific
│   ├── rich-content/          # Dynamic-specific
│   ├── schema/                # Shared
│   ├── tables/                # Dynamic-specific
│   ├── utils/                 # Shared (y-keyvalue-lww)
│   └── workspace/             # Dynamic-specific
├── dynamic/                   # Cell-level CRDT API
├── static/                    # Row-level versioned schema API
├── extensions/                # Workspace extensions
├── server/                    # HTTP/MCP server
├── cli/                       # CLI tooling
└── index.ts                   # Main public exports
```

## Target State

```
packages/epicenter/src/
├── core/                      # ONLY shared primitives
│   ├── actions.ts             # Keep (used by server/CLI)
│   ├── errors.ts              # Keep
│   ├── lifecycle.ts           # Keep
│   ├── types.ts               # Keep
│   ├── schema/                # Keep (used by both APIs + extensions)
│   │   ├── fields/
│   │   ├── converters/
│   │   ├── standard/
│   │   └── index.ts
│   └── utils/
│       ├── y-keyvalue-lww.ts  # Keep
│       └── y-keyvalue-lww.test.ts
├── dynamic/                   # Full dynamic implementation
│   ├── docs/                  # MOVED from core/docs/
│   │   ├── workspace-doc.ts
│   │   ├── head-doc.ts
│   │   ├── index.ts
│   │   └── README.md
│   ├── tables/                # MOVED from core/tables/
│   │   ├── create-tables.ts
│   │   ├── table-helper.ts
│   │   └── *.test.ts
│   ├── workspace/             # MOVED from core/workspace/
│   │   ├── workspace.ts
│   │   ├── normalize.ts
│   │   ├── node.ts
│   │   └── README.md
│   ├── kv/                    # MOVED from core/kv/
│   │   └── core.ts
│   ├── definition-helper/     # MOVED from core/definition-helper/
│   ├── rich-content/          # MOVED from core/rich-content/
│   ├── extension.ts           # MOVED from core/extension.ts
│   ├── create-workspace.ts    # Already exists
│   ├── table-helper.ts        # Already exists (cell-level)
│   ├── extensions.ts          # Already exists
│   ├── keys.ts                # Already exists
│   ├── stores/                # Already exists
│   ├── types.ts               # Already exists
│   └── index.ts               # Update exports
├── static/                    # No changes needed
├── extensions/                # Update imports
├── server/                    # Update imports
├── cli/                       # Update imports
└── index.ts                   # Update import paths
```

## Modules to Move

### From `core/` to `dynamic/`

| Source                    | Destination                  | Notes                                                                 |
| ------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `core/docs/`              | `dynamic/docs/`              | workspace-doc.ts, head-doc.ts, index.ts, README.md, provider-types.ts |
| `core/tables/`            | `dynamic/tables/`            | create-tables.ts, table-helper.ts, all tests                          |
| `core/workspace/`         | `dynamic/workspace/`         | workspace.ts, normalize.ts, node.ts, index.ts, README.md, tests       |
| `core/kv/`                | `dynamic/kv/`                | core.ts, kv-helper.ts, tests                                          |
| `core/definition-helper/` | `dynamic/definition-helper/` | definition-helper.ts, index.ts, tests                                 |
| `core/rich-content/`      | `dynamic/rich-content/`      | id.ts                                                                 |
| `core/extension.ts`       | `dynamic/extension.ts`       | Re-exports, update paths                                              |

### Files to Delete (Dead Code)

| File                                       | Reason                                                         |
| ------------------------------------------ | -------------------------------------------------------------- |
| `core/utils/ykv-stress-test.ts`            | Zero imports in codebase                                       |
| `core/utils/y-keyvalue.ts`                 | Only imported by tests (positional version, superseded by LWW) |
| `core/utils/y-keyvalue.test.ts`            | Tests for deleted file                                         |
| `core/utils/ymap-simplicity-case.test.ts`  | Verify if still needed                                         |
| `core/utils/y-keyvalue-comparison.test.ts` | Compares deleted implementation                                |

### Files to Keep in `core/`

| File                                | Reason                                                |
| ----------------------------------- | ----------------------------------------------------- |
| `core/actions.ts`                   | Used by server/, cli/ - standalone subsystem          |
| `core/errors.ts`                    | Used by extensions/                                   |
| `core/lifecycle.ts`                 | Used by both static/ and dynamic/                     |
| `core/types.ts`                     | Used by extensions/, cli/                             |
| `core/schema/` (entire folder)      | Used by static/, dynamic/, extensions/, server/, cli/ |
| `core/utils/y-keyvalue-lww.ts`      | Used by both static/ and dynamic/                     |
| `core/utils/y-keyvalue-lww.test.ts` | Tests for shared utility                              |

## Import Update Map

After moving files, update imports in these locations:

### 1. `src/index.ts` (Main Public Exports)

```typescript
// BEFORE
export { createWorkspaceDoc, WORKSPACE_DOC_MAPS } from './core/docs';
export { createTables } from './core/tables/create-tables';
export { defineWorkspace } from './core/workspace/workspace';
export { createKv } from './core/kv/core';
export { defineExports } from './core/extension';
export { createRichContentId } from './core/rich-content/id';
export { normalizeIcon, ... } from './core/workspace/normalize';

// AFTER
export { createWorkspaceDoc, WORKSPACE_DOC_MAPS } from './dynamic/docs';
export { createTables } from './dynamic/tables/create-tables';
export { defineWorkspace } from './dynamic/workspace/workspace';
export { createKv } from './dynamic/kv/core';
export { defineExports } from './dynamic/extension';
export { createRichContentId } from './dynamic/rich-content/id';
export { normalizeIcon, ... } from './dynamic/workspace/normalize';
```

### 2. `dynamic/index.ts`

Update to export from local paths instead of `../core/`:

```typescript
// BEFORE
export { createHeadDoc, type HeadDoc } from '../core/docs/head-doc';
export { defineExports, type Lifecycle } from '../core/lifecycle';

// AFTER
export { createHeadDoc, type HeadDoc } from './docs/head-doc';
export { defineExports, type Lifecycle } from '../core/lifecycle'; // lifecycle stays in core
```

### 3. `extensions/` Folder

Files to update:

- `extensions/persistence/web.ts`
- `extensions/persistence/desktop.ts`
- `extensions/sqlite/sqlite.ts`
- `extensions/sqlite/builders.ts`
- `extensions/markdown/markdown.ts`
- `extensions/markdown/configs.ts`
- `extensions/markdown/io.ts`
- `extensions/markdown/diagnostics-manager.ts`
- `extensions/revision-history/local.ts`
- `extensions/websocket-sync.ts`

Pattern:

```typescript
// BEFORE
import { defineExports, type ExtensionContext } from '../../core/extension';
import type { TableHelper } from '../../core/tables/create-tables';

// AFTER
import { defineExports, type ExtensionContext } from '../../dynamic/extension';
import type { TableHelper } from '../../dynamic/tables/create-tables';
```

**Note**: Imports from `core/schema`, `core/errors`, `core/types` should STAY as-is (they remain in core).

### 4. `server/` Folder

Files to update:

- `server/server.ts`
- `server/tables.ts`
- `server/actions.ts`
- `server/actions.test.ts`

Pattern:

```typescript
// BEFORE
import type { WorkspaceDoc } from '../core/docs/workspace-doc';

// AFTER
import type { WorkspaceDoc } from '../dynamic/docs/workspace-doc';
```

**Note**: `core/actions` imports should STAY as-is (actions remain in core).

### 5. `cli/` Folder

Files to update:

- `cli/cli.ts`
- `cli/discovery.ts`
- `cli/command-builder.ts`
- `cli/cli.test.ts`
- `cli/command-builder.test.ts`

Pattern:

```typescript
// BEFORE
import type { WorkspaceDoc } from '../core/docs/workspace-doc';

// AFTER
import type { WorkspaceDoc } from '../dynamic/docs/workspace-doc';
```

**Note**: `core/actions` and `core/types` imports should STAY as-is.

### 6. Internal `dynamic/` Files

After moving, update internal imports within moved files:

| File                            | Update Pattern                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `dynamic/docs/workspace-doc.ts` | `../definition-helper` (now local), `../kv/core` (now local), `../tables/create-tables` (now local) |
| `dynamic/extension.ts`          | `./docs/workspace-doc` (now local)                                                                  |
| `dynamic/create-workspace.ts`   | Already uses `../core/lifecycle` (stays), update others to local                                    |
| `dynamic/types.ts`              | `./workspace/workspace` (now local)                                                                 |

## Execution Steps

### Phase 1: Preparation

1. **Run tests to establish baseline**

   ```bash
   cd packages/epicenter && bun test
   ```

2. **Verify no uncommitted changes**

   ```bash
   git status
   ```

3. **Create feature branch**
   ```bash
   git checkout -b refactor/core-reorganization
   ```

### Phase 2: Move Files

Execute moves in dependency order (leaf dependencies first):

1. **Move `core/definition-helper/` to `dynamic/definition-helper/`**
2. **Move `core/rich-content/` to `dynamic/rich-content/`**
3. **Move `core/kv/` to `dynamic/kv/`**
4. **Move `core/tables/` to `dynamic/tables/`**
5. **Move `core/workspace/` to `dynamic/workspace/`**
6. **Move `core/docs/` to `dynamic/docs/`**
7. **Move `core/extension.ts` to `dynamic/extension.ts`**

For each move:

```bash
git mv core/X dynamic/X
```

### Phase 3: Update Imports

Use find-and-replace or AST tools. Update in this order:

1. **Update moved files' internal imports** (within `dynamic/`)
2. **Update `dynamic/index.ts`**
3. **Update `src/index.ts`**
4. **Update `extensions/` imports**
5. **Update `server/` imports**
6. **Update `cli/` imports**

### Phase 4: Delete Dead Code

```bash
rm core/utils/ykv-stress-test.ts
rm core/utils/y-keyvalue.ts
rm core/utils/y-keyvalue.test.ts
rm core/utils/y-keyvalue-comparison.test.ts
```

Verify `ymap-simplicity-case.test.ts` - delete if only tests deleted code.

### Phase 5: Verification

1. **TypeScript compilation**

   ```bash
   cd packages/epicenter && bun run typecheck
   ```

2. **Run all tests**

   ```bash
   bun test
   ```

3. **Build package**

   ```bash
   bun run build
   ```

4. **Verify package exports work**
   ```bash
   # Test that public API still works
   bun run test:exports  # if such a script exists
   ```

### Phase 6: Cleanup

1. **Remove empty directories in `core/`**
2. **Update any README.md files that reference old paths**
3. **Update package.json exports if needed** (check `"./node"` export)

## Validation Checklist

After completion, verify:

- [ ] `core/` contains ONLY: `actions.ts`, `errors.ts`, `lifecycle.ts`, `types.ts`, `schema/`, `utils/y-keyvalue-lww.*`
- [ ] `dynamic/` contains all moved folders: `docs/`, `tables/`, `workspace/`, `kv/`, `definition-helper/`, `rich-content/`, `extension.ts`
- [ ] All tests pass
- [ ] TypeScript compiles without errors
- [ ] Package builds successfully
- [ ] Public API (`src/index.ts`) exports remain unchanged (just internal paths changed)
- [ ] `static/` folder is untouched (already independent)

## Files Reference

### Files that import from `core/` (need review)

```
src/index.ts
dynamic/index.ts
dynamic/create-workspace.ts
dynamic/types.ts
dynamic/extensions.ts
dynamic/table-helper.ts
dynamic/stores/kv-store.ts
static/create-workspace.ts
static/create-tables.ts
static/create-kv.ts
static/table-helper.ts
static/types.ts
static/define-workspace.test.ts
static/create-tables.test.ts
static/table-helper.test.ts
static/create-kv.test.ts
extensions/persistence/web.ts
extensions/persistence/desktop.ts
extensions/sqlite/sqlite.ts
extensions/sqlite/builders.ts
extensions/markdown/markdown.ts
extensions/markdown/configs.ts
extensions/markdown/io.ts
extensions/markdown/diagnostics-manager.ts
extensions/revision-history/local.ts
extensions/websocket-sync.ts
server/server.ts
server/tables.ts
server/actions.ts
server/actions.test.ts
cli/cli.ts
cli/discovery.ts
cli/command-builder.ts
cli/cli.test.ts
cli/command-builder.test.ts
cli/json-schema-to-yargs.test.ts
```

### Core files that STAY in core (import paths unchanged)

Any file importing these should NOT be updated:

- `core/actions.ts`
- `core/errors.ts`
- `core/lifecycle.ts`
- `core/types.ts`
- `core/schema/*`
- `core/utils/y-keyvalue-lww.ts`

## Notes for Executing Agent

1. **Use sub-agents liberally** - Before making changes, spawn explore agents to:
   - Double-check all imports of each file being moved
   - Verify no hidden dependencies were missed
   - Confirm which files need import updates

2. **Move in small batches** - Move one folder, update its imports, run tests, commit. Don't do everything at once.

3. **Preserve git history** - Use `git mv` for moves so history is preserved.

4. **Watch for circular dependencies** - After moving, some imports might create cycles. If `dynamic/docs/workspace-doc.ts` imports from `dynamic/tables/` and vice versa, you may need to reorganize.

5. **Check package.json exports** - The package has subpath exports like `"./node"`. Verify these still work after the move.

6. **Run tests frequently** - After each phase, run `bun test` to catch issues early.

7. **The public API must not change** - External consumers import from `@epicenter/hq`. The same exports must remain available, just sourced from different internal paths.

---

## Review

**Status**: ✅ Completed (2026-01-31)

**Note (2026-01-31)**: After this reorganization, the `dynamic/docs/` folder was further flattened. The files `head-doc.ts`, `workspace-doc.ts`, and `provider-types.ts` were moved directly into `dynamic/`, and the README was renamed to `YDOC-ARCHITECTURE.md`. See the subsequent specs for details on this flatten.

### Summary of Changes

The reorganization was successfully executed. `core/` now contains only shared primitives; all dynamic-specific code lives in `dynamic/`.

### Files Moved (using `git mv`)

| From                      | To                           |
| ------------------------- | ---------------------------- |
| `core/docs/`              | `dynamic/docs/`              |
| `core/tables/`            | `dynamic/tables/`            |
| `core/workspace/`         | `dynamic/workspace/`         |
| `core/kv/`                | `dynamic/kv/`                |
| `core/definition-helper/` | `dynamic/definition-helper/` |
| `core/rich-content/`      | `dynamic/rich-content/`      |
| `core/extension.ts`       | `dynamic/extension.ts`       |

### Dead Code Deleted

- `core/utils/y-keyvalue.ts` (superseded by y-keyvalue-lww.ts)
- `core/utils/y-keyvalue.test.ts`
- `core/utils/y-keyvalue-comparison.test.ts`
- `core/utils/ykv-stress-test.ts` (untracked)

### Imports Updated

Files with import path changes:

- `src/index.ts` - Updated exports to source from `./dynamic/`
- `dynamic/index.ts` - Updated to use local `./docs/head-doc`
- `dynamic/types.ts` - Updated to use local `./workspace/workspace`
- `extensions/websocket-sync.ts` - Updated `WorkspaceDoc` import
- `extensions/markdown/markdown.ts` - Updated `extension` and `tables` imports
- `extensions/sqlite/sqlite.ts` - Updated `extension` import
- `extensions/persistence/desktop.ts` - Updated `extension` import
- `extensions/persistence/web.ts` - Updated `extension` import
- `extensions/revision-history/local.ts` - Updated `extension` import
- `server/server.ts` - Updated `WorkspaceDoc` import
- `server/tables.ts` - Updated `TableHelper` import
- `cli/cli.ts` - Updated `WorkspaceDoc` import
- `cli/discovery.ts` - Updated `WorkspaceDoc` import
- `core/schema/schema-file.ts` - Updated `Workspace` import

### Final Structure

**`core/` contains:**

```
core/
├── actions.ts      # Server/CLI actions
├── errors.ts       # Shared error types
├── lifecycle.ts    # Shared lifecycle protocol
├── types.ts        # Shared types
├── schema/         # Shared schema system
└── utils/
    └── y-keyvalue-lww.ts  # Shared CRDT utility
```

**`dynamic/` contains:**

```
dynamic/
├── docs/               # MOVED
├── tables/             # MOVED
├── workspace/          # MOVED
├── kv/                 # MOVED
├── definition-helper/  # MOVED
├── rich-content/       # MOVED
├── extension.ts        # MOVED
├── create-workspace.ts # Already existed
├── extensions.ts       # Already existed
├── keys.ts             # Already existed
├── stores/             # Already existed
├── table-helper.ts     # Already existed
├── types.ts            # Already existed
└── index.ts            # Already existed
```

### Verification

- **Tests**: 468 pass, 2 skip, 0 fail
- **TypeScript**: Pre-existing errors only (in scripts/, not in src/)
- **Public API**: Unchanged - external consumers see no difference

### Commits

1. `790776d1c` - refactor(epicenter): reorganize core/ to contain only shared primitives
2. (pending) - fix(epicenter): update stale extension imports after core reorganization
