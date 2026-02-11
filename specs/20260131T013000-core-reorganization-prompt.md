# Agent Prompt: Execute Core Reorganization

Copy everything below this line to give to an agent:

---

## Task: Execute Core Folder Reorganization

Read and execute the specification at `/Users/braden/Code/epicenter/specs/20260131T013000-core-folder-reorganization.md`.

**Note (2026-01-31)**: After this reorganization was completed, the `dynamic/docs/` folder was further flattened. The files `head-doc.ts`, `workspace-doc.ts`, and `provider-types.ts` were moved directly into `dynamic/`, and the README was renamed to `YDOC-ARCHITECTURE.md`. See the subsequent specs for details.

### Summary

Reorganize `packages/epicenter/src/core/` so it contains ONLY truly shared primitives. Move dynamic-specific code (`docs/`, `tables/`, `workspace/`, `kv/`, `definition-helper/`, `rich-content/`, `extension.ts`) from `core/` to `dynamic/`.

### Key Constraints

1. **Public API must not change** - `src/index.ts` exports the same things, just from different internal paths
2. **Preserve git history** - Use `git mv` for all file moves
3. **Tests must pass** - Run tests after each phase
4. **Static folder is untouched** - Only `core/` and `dynamic/` change

### Execution Approach

**Before making ANY changes:**

1. Read the full specification document
2. Use sub-agents to explore and verify:
   - Spawn an explore agent to find ALL imports of files being moved
   - Spawn an explore agent to verify the "Files Reference" section is complete
   - Confirm no hidden dependencies were missed

**Execute in phases (commit after each):**

1. **Phase 1**: Establish baseline (run tests, verify clean state)
2. **Phase 2**: Move files using `git mv` in dependency order:
   - `definition-helper/` first (leaf dependency)
   - `rich-content/`
   - `kv/`
   - `tables/`
   - `workspace/`
   - `docs/`
   - `extension.ts`
3. **Phase 3**: Update imports in moved files, then in consumers
4. **Phase 4**: Delete dead code (`ykv-stress-test.ts`, `y-keyvalue.ts`, related tests)
5. **Phase 5**: Verify (typecheck, test, build)
6. **Phase 6**: Cleanup (empty dirs, README updates)

### Critical Details

**Files that STAY in core (do NOT move, do NOT update imports to these):**

- `core/actions.ts`
- `core/errors.ts`
- `core/lifecycle.ts`
- `core/types.ts`
- `core/schema/*` (entire folder)
- `core/utils/y-keyvalue-lww.ts`

**Files that MOVE to dynamic:**

- `core/docs/` -> `dynamic/docs/`
- `core/tables/` -> `dynamic/tables/`
- `core/workspace/` -> `dynamic/workspace/`
- `core/kv/` -> `dynamic/kv/`
- `core/definition-helper/` -> `dynamic/definition-helper/`
- `core/rich-content/` -> `dynamic/rich-content/`
- `core/extension.ts` -> `dynamic/extension.ts`

### Verification

After completion:

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes
- [ ] `bun run build` succeeds
- [ ] `core/` contains ONLY the "stay" files listed above
- [ ] All moved folders exist in `dynamic/`

### Notes

- Work incrementally. Move one folder, update imports, test, commit.
- If you hit circular dependency issues, document and ask for guidance.
- The specification has detailed import update patterns - follow them.
- Use `git mv` not `mv` to preserve history.
- Check `package.json` exports after moving (especially `"./node"` export).

Begin by reading the spec, then use sub-agents to verify the scope before making changes.
