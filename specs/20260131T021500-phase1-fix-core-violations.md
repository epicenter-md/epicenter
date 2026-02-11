# Phase 1: Fix Core Layer Violations

**Status**: Ready for execution  
**Risk**: Low  
**Scope**: 4 independent tasks (can be parallelized)

## Context

The `packages/epicenter/src/core` directory has several violations of its intended role as a foundational layer. These are bugs, not architectural decisions, and should be fixed immediately.

## Tasks

This phase consists of 4 independent tasks. Each can be assigned to a separate agent and executed in parallel.

---

### Task 1: Fix Layering Violation in schema-file.ts

**File**: `packages/epicenter/src/core/schema/schema-file.ts`

**Problem**: Line 19 imports from `../../dynamic/workspace/workspace`, which violates the rule that `core` should not depend on `dynamic`.

**Solution**: Move `WorkspaceDefinition` type to core.

**Steps**:

1. Read `packages/epicenter/src/dynamic/workspace/workspace.ts` to understand `WorkspaceDefinition`
2. The type is pure (no Yjs dependencies) - it's just a shape definition
3. Create `packages/epicenter/src/core/schema/workspace-definition.ts` with the type
4. Update `core/schema/schema-file.ts` to import from the new location
5. Update `dynamic/workspace/workspace.ts` to re-export from core (for backwards compatibility)
6. Update `dynamic/index.ts` if it re-exports `WorkspaceDefinition`
7. Update `src/index.ts` if it imports `WorkspaceDefinition` from dynamic
8. Run `bun run typecheck` in `packages/epicenter` to verify no type errors
9. Run `bun test` to verify no test failures

**Verification**:

```bash
# No imports from dynamic in core
grep -r "from.*dynamic" packages/epicenter/src/core/
# Should return empty
```

**Acceptance Criteria**:

- [ ] `WorkspaceDefinition` type lives in `core/`
- [ ] No files in `core/` import from `dynamic/` or `static/`
- [ ] All existing imports of `WorkspaceDefinition` still work
- [ ] `bun run typecheck` passes
- [ ] `bun test` passes

---

### Task 2: Fix Broken Package Export

**File**: `packages/epicenter/package.json`

**Problem**: Line 10 exports `"./node": "./src/core/workspace/node.ts"` but the file is actually at `./src/dynamic/workspace/node.ts`.

**Solution**: Fix the path.

**Steps**:

1. Verify the file exists at `packages/epicenter/src/dynamic/workspace/node.ts`
2. Update `package.json` line 10 to: `"./node": "./src/dynamic/workspace/node.ts"`
3. Run `bun run typecheck` to verify the export works

**Verification**:

```bash
# File should exist
ls packages/epicenter/src/dynamic/workspace/node.ts
```

**Acceptance Criteria**:

- [ ] `package.json` points to correct file
- [ ] Import `from '@epicenter/hq/node'` resolves correctly

---

### Task 3: Remove Deprecated Export

**File**: `packages/epicenter/src/index.ts`

**Problem**: `LifecycleExports` is marked `@deprecated` in `core/lifecycle.ts` but still exported from the main index.

**Solution**: Remove the deprecated export from the public API.

**Steps**:

1. Read `packages/epicenter/src/core/lifecycle.ts` to confirm `LifecycleExports` is deprecated
2. Search for usages of `LifecycleExports` across the codebase:
   ```bash
   grep -r "LifecycleExports" packages/ apps/
   ```
3. If there are usages, update them to use the non-deprecated alternative (likely `Lifecycle` + `defineExports`)
4. Remove `LifecycleExports` from `packages/epicenter/src/index.ts` exports
5. Run `bun run typecheck` to verify no broken imports
6. Run `bun test` to verify no test failures

**Acceptance Criteria**:

- [ ] `LifecycleExports` not exported from `src/index.ts`
- [ ] No usages of `LifecycleExports` remain in codebase (or they use internal import)
- [ ] `bun run typecheck` passes
- [ ] `bun test` passes

---

### Task 4: Consolidate Duplicate fieldToTypebox

**Files**:

- `packages/epicenter/src/core/schema/converters/to-typebox.ts` (canonical)
- `packages/epicenter/src/dynamic/stores/kv-store.ts` (duplicate, lines ~42-82)
- `packages/epicenter/src/dynamic/table-helper.ts` (duplicate, lines ~52-115)

**Problem**: `fieldToTypebox` is implemented 3 times. The canonical version is in core, but dynamic has two local copies.

**Solution**: Delete duplicates and import from core.

**Steps**:

1. Read all three implementations to confirm they're functionally equivalent
2. In `dynamic/stores/kv-store.ts`:
   - Remove the local `fieldToTypebox` function
   - Add import: `import { fieldToTypebox } from '../../core/schema/converters/to-typebox'`
   - Update any type differences if needed
3. In `dynamic/table-helper.ts`:
   - Remove the local `fieldToTypebox` function
   - Add import: `import { fieldToTypebox } from '../core/schema/converters/to-typebox'`
   - Update any type differences if needed
4. Run `bun run typecheck` to verify no type errors
5. Run `bun test` to verify no test failures

**Note**: The implementations might have slight differences for handling dynamic-specific field types. If so, document the differences and create a wrapper function in dynamic that calls the core version with adjustments.

**Acceptance Criteria**:

- [ ] Only ONE `fieldToTypebox` implementation exists (in core)
- [ ] Dynamic files import from core
- [ ] `bun run typecheck` passes
- [ ] `bun test` passes

---

## Execution Notes

**For Agents**:

- Each task is independent; do not modify files outside your task scope
- Run verification commands after each change
- If you encounter unexpected issues, document them and stop
- Use `git diff` to review changes before committing

**Commit Strategy**:

- One commit per task
- Commit message format: `fix(epicenter): <description>`
- Example: `fix(epicenter): move WorkspaceDefinition to core to fix layering violation`

## Post-Execution

After all 4 tasks complete:

1. Run full test suite: `bun test` from `packages/epicenter`
2. Run typecheck: `bun run typecheck` from `packages/epicenter`
3. Verify no core → dynamic imports: `grep -r "from.*dynamic" packages/epicenter/src/core/`
