# Extract CLI from @epicenter/workspace into packages/cli

## Goal

Move `packages/epicenter/src/cli/` into a standalone `packages/cli/` package (`@epicenter/cli`). The CLI currently lives inside the core library but has almost zero coupling to its internals, only one non-public import needs resolving.

## Why This Matters

1. **Dependency cleanup**: `yargs` (+ `@types/yargs`) is a CLI-only dependency polluting the core library
2. **Logical separation**: The CLI is already semi-separated (`./cli` subpath export, own README)
3. **Architecture clarity**: Keeps `@epicenter/workspace` focused on the workspace runtime
4. **Monorepo hygiene**: Clear boundaries between runtime and tooling packages

## Current State Analysis

### Files to Move

All files under `packages/epicenter/src/cli/`:

```
src/cli/
├── bin.ts              (entry point)
├── cli.ts              (main CLI orchestrator)
├── cli.test.ts         (tests)
├── command-builder.ts  (yargs command generation)
├── command-builder.test.ts
├── discovery.ts        (workspace config discovery)
├── format-output.ts    (output formatting)
├── format-output.test.ts
├── index.ts            (public export)
├── integration.test.ts
├── json-schema-to-yargs.ts
├── json-schema-to-yargs.test.ts
├── parse-input.ts      (input parsing)
├── parse-input.test.ts
├── README.md
└── commands/
    ├── kv-commands.ts
    ├── meta-commands.ts
    └── table-commands.ts
```

### Import Dependencies (Files Requiring Rewiring)

Only **2 files** import from `@epicenter/workspace` internals:

1. **discovery.ts**
   ```typescript
   // Current
   import type { ProjectDir } from '../shared/types';
   import type { AnyWorkspaceClient } from '../workspace/types';

   // Target
   import type { ProjectDir, AnyWorkspaceClient } from '@epicenter/workspace';
   ```

2. **command-builder.ts**
   ```typescript
   // Current
   import type { Actions } from '../shared/actions';
   import { iterateActions } from '../shared/actions';
   import { standardSchemaToJsonSchema } from '../shared/standard-schema/to-json-schema';

   // Target
   import { type Actions, iterateActions, standardSchemaToJsonSchema } from '@epicenter/workspace';
   ```

### Test Files (cli.test.ts, command-builder.test.ts, json-schema-to-yargs.test.ts)

Same import pattern as their source files.

### Other Files (No Changes Needed)

- `cli.ts`, `format-output.ts`, `parse-input.ts`, `commands/*.ts`: Only import from relative `.` paths (sibling files)
- These imports remain unchanged

## Implementation Steps

### Step 1: Export standardSchemaToJsonSchema from @epicenter/workspace

**File**: `packages/epicenter/src/index.ts`

Add `standardSchemaToJsonSchema` to the public API. It's already exported from `src/shared/standard-schema/index.ts`, so we just re-export it.

This is safe because:
- `describe-workspace.ts` already uses it internally
- It's a pure utility function with no side effects
- No version/API stability concerns

### Step 2: Create packages/cli/ Structure

Create the new package directory and copy structure:

```
packages/cli/
├── package.json       (new file)
├── tsconfig.json      (copy from epicenter)
└── src/
    ├── bin.ts         (moved)
    ├── cli.ts         (moved)
    ├── cli.test.ts    (moved)
    ├── command-builder.ts  (moved + rewired)
    ├── command-builder.test.ts (moved + rewired)
    ├── discovery.ts   (moved + rewired)
    ├── format-output.ts (moved)
    ├── format-output.test.ts (moved)
    ├── index.ts       (moved)
    ├── integration.test.ts (moved)
    ├── json-schema-to-yargs.ts (moved)
    ├── json-schema-to-yargs.test.ts (moved)
    ├── parse-input.ts (moved)
    ├── parse-input.test.ts (moved)
    ├── README.md      (moved)
    └── commands/
        ├── kv-commands.ts (moved)
        ├── meta-commands.ts (moved)
        └── table-commands.ts (moved)
```

### Step 3: Create packages/cli/package.json

```json
{
  "name": "@epicenter/cli",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "bin": {
    "epicenter": "./src/bin.ts"
  },
  "dependencies": {
    "@epicenter/workspace": "workspace:*",
    "wellcrafted": "catalog:",
    "yargs": "catalog:"
  },
  "devDependencies": {
    "@types/yargs": "catalog:",
    "typescript": "catalog:"
  }
}
```

### Step 4: Create packages/cli/tsconfig.json

Copy verbatim from `packages/epicenter/tsconfig.json`.

### Step 5: Rewire Imports in Moved Files

**discovery.ts**:
```typescript
// FROM:
import type { ProjectDir } from '../shared/types';
import type { AnyWorkspaceClient } from '../workspace/types';

// TO:
import type { ProjectDir, AnyWorkspaceClient } from '@epicenter/workspace';
```

**command-builder.ts**:
```typescript
// FROM:
import type { Actions } from '../shared/actions';
import { iterateActions } from '../shared/actions';
import { standardSchemaToJsonSchema } from '../shared/standard-schema/to-json-schema';

// TO:
import { type Actions, iterateActions, standardSchemaToJsonSchema } from '@epicenter/workspace';
```

**Test files** (cli.test.ts, command-builder.test.ts, json-schema-to-yargs.test.ts):
- Same import rewiring pattern as source files
- Any `../shared/*` imports → `@epicenter/workspace`

### Step 6: Clean Up packages/epicenter/

**In package.json**:
1. Remove `"bin"` entry
2. Remove `"./cli"` from `"exports"`
3. Remove `"yargs"` from `"dependencies"`
4. Remove `"@types/yargs"` from `"devDependencies"`

**Delete**:
- `packages/epicenter/src/cli/` (entire directory)

### Step 7: Run bun install

From repository root:
```bash
bun install
```

This registers the new workspace package and links it.

### Step 8: Verify Everything Works

Run these verification checks in order:

1. **CLI tests pass**:
   ```bash
   bun test packages/cli/
   ```

2. **CLI type checks**:
   ```bash
   bun run typecheck --project packages/cli/tsconfig.json
   ```

3. **Core library type checks**:
   ```bash
   bun run typecheck --project packages/epicenter/tsconfig.json
   ```

4. **Full repo type checks**:
   ```bash
   bun run typecheck
   ```

All should pass with no type errors or missing imports.

## What NOT to Do

❌ Don't refactor any CLI logic: pure move + import rewire only
❌ Don't rename files or restructure the commands/ folder
❌ Don't touch @epicenter/server (CLI dynamically imports it via `await import()`: stays as-is)
❌ Don't change any behavior: CLI should work identically after extraction
❌ Don't manually copy files: use bun or git operations for precision

## Todo List

- [ ] Export standardSchemaToJsonSchema from @epicenter/workspace
- [ ] Create packages/cli/ directory structure
- [ ] Create packages/cli/package.json
- [ ] Create packages/cli/tsconfig.json
- [ ] Copy CLI files to packages/cli/src/
- [ ] Rewire imports in discovery.ts
- [ ] Rewire imports in command-builder.ts
- [ ] Rewire imports in CLI test files
- [ ] Clean up packages/epicenter/package.json
- [ ] Delete packages/epicenter/src/cli/
- [ ] Run bun install
- [ ] Verify all tests pass
- [ ] Verify all type checks pass

## Success Criteria

✅ All CLI tests pass
✅ No type errors in CLI package
✅ No type errors in epicenter package
✅ No type errors across entire repo
✅ `bun run epicenter --help` works
✅ CLI commands execute as before
✅ No breaking changes to CLI behavior or API

## Rollback Strategy

If anything fails:

1. Revert package.json changes: `git checkout packages/epicenter/package.json`
2. Restore CLI directory: `git checkout packages/epicenter/src/cli/`
3. Remove new package: `rm -rf packages/cli/`
4. Reinstall: `bun install`

All changes are isolated, no complex merge conflicts expected.

## Notes

- The CLI doesn't import from other @epicenter/* packages at the code level (only @epicenter/workspace)
- Dynamic imports like `await import('@epicenter/server')` will continue to work (that's the design)
- No changes to the bin entry point: just moved to a new location
- The workspace ID convention ("epicenter.config.ts") remains unchanged
