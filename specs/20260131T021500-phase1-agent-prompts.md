# Phase 1: Agent Prompts

Copy and paste each prompt to a separate agent. Tasks are independent and can run in parallel.

---

## Agent 1: Fix Layering Violation

```
TASK: Fix layering violation in packages/epicenter/src/core/schema/schema-file.ts

PROBLEM: Line 19 imports WorkspaceDefinition from ../../dynamic/workspace/workspace
This violates the architectural rule: core/ must not depend on dynamic/ or static/

SOLUTION:
1. Read packages/epicenter/src/dynamic/workspace/workspace.ts to understand WorkspaceDefinition type
2. Create packages/epicenter/src/core/schema/workspace-definition.ts containing just the WorkspaceDefinition type (it's pure, no Yjs deps)
3. Update core/schema/schema-file.ts to import from ./workspace-definition
4. Update core/schema/index.ts to re-export WorkspaceDefinition if appropriate
5. Update dynamic/workspace/workspace.ts to import and re-export from core (backwards compat)
6. Check dynamic/index.ts - if it exports WorkspaceDefinition, update the import path
7. Check src/index.ts - if it imports WorkspaceDefinition from dynamic, update to import from core

VERIFICATION:
- Run: grep -r "from.*dynamic" packages/epicenter/src/core/
  Expected: No results
- Run: bun run typecheck (from packages/epicenter)
- Run: bun test (from packages/epicenter)

COMMIT: fix(epicenter): move WorkspaceDefinition to core to fix layering violation

DO NOT modify files outside packages/epicenter/src/core/ and packages/epicenter/src/dynamic/workspace/ unless necessary for re-exports.
```

---

## Agent 2: Fix Broken Package Export

```
TASK: Fix broken package.json export path

PROBLEM: packages/epicenter/package.json line 10 has:
  "./node": "./src/core/workspace/node.ts"
But the file is actually at ./src/dynamic/workspace/node.ts

SOLUTION:
1. Verify file exists: ls packages/epicenter/src/dynamic/workspace/node.ts
2. Edit packages/epicenter/package.json line 10 to:
   "./node": "./src/dynamic/workspace/node.ts"

VERIFICATION:
- Run: bun run typecheck (from packages/epicenter)

COMMIT: fix(epicenter): correct ./node export path in package.json

This is a one-line fix. Do not make any other changes.
```

---

## Agent 3: Remove Deprecated Export

```
TASK: Remove deprecated LifecycleExports from public API

PROBLEM: LifecycleExports is marked @deprecated in core/lifecycle.ts but still exported from src/index.ts

SOLUTION:
1. Read packages/epicenter/src/core/lifecycle.ts to confirm deprecation
2. Search for usages: grep -r "LifecycleExports" packages/ apps/
3. If usages exist outside core/lifecycle.ts:
   - Update them to use Lifecycle type + defineExports() instead
   - Or if they truly need LifecycleExports, have them import directly from core/lifecycle
4. Remove "LifecycleExports" from the export statement in packages/epicenter/src/index.ts

VERIFICATION:
- Run: bun run typecheck (from packages/epicenter)
- Run: bun test (from packages/epicenter)

COMMIT: fix(epicenter): remove deprecated LifecycleExports from public exports

If LifecycleExports has many external usages, document them and ask for guidance before removing.
```

---

## Agent 4: Consolidate Duplicate fieldToTypebox

```
TASK: Remove duplicate fieldToTypebox implementations

PROBLEM: fieldToTypebox is implemented 3 times:
- packages/epicenter/src/core/schema/converters/to-typebox.ts (canonical)
- packages/epicenter/src/dynamic/stores/kv-store.ts (duplicate, ~lines 42-82)
- packages/epicenter/src/dynamic/table-helper.ts (duplicate, ~lines 52-115)

SOLUTION:
1. Read all three implementations to understand differences
2. In dynamic/stores/kv-store.ts:
   - Delete the local fieldToTypebox function
   - Add: import { fieldToTypebox } from '../../core/schema/converters/to-typebox'
   - Fix any type mismatches
3. In dynamic/table-helper.ts:
   - Delete the local fieldToTypebox function
   - Add: import { fieldToTypebox } from '../core/schema/converters/to-typebox'
   - Fix any type mismatches

NOTE: The dynamic implementations might handle slightly different field types (e.g., dynamic-specific fields). If so:
- Keep using core's fieldToTypebox for common cases
- Add a small wrapper function for dynamic-specific handling
- Document why the wrapper exists

VERIFICATION:
- Run: grep -n "function fieldToTypebox" packages/epicenter/src/
  Expected: Only one result (in core/schema/converters/to-typebox.ts)
- Run: bun run typecheck (from packages/epicenter)
- Run: bun test (from packages/epicenter)

COMMIT: refactor(epicenter): consolidate fieldToTypebox to single implementation in core
```

---

## Execution Order

These 4 tasks are independent. You can:

- Run all 4 in parallel (fastest)
- Run sequentially if you prefer reviewing each

After all complete, run from packages/epicenter:

```bash
bun run typecheck
bun test
grep -r "from.*dynamic" src/core/  # Should be empty
```
