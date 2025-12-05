# Migrate Specs to Root Level

## Overview

This is a handoff document for another coding agent. The task is to move specs from `/docs/specs/` subdirectories to root-level `/specs/` directories for consistency.

## Background

The project has adopted a convention that specs always live at the root level of their scope:

- `/docs/specs/` - Cross-cutting specs (keep as-is)
- `/apps/[app]/specs/` - App-specific specs (already correct)
- `/packages/[pkg]/specs/` - Package-specific specs (needs migration)

## Migration Required

### Move: `packages/epicenter/docs/specs/` → `packages/epicenter/specs/`

The following 16 files need to be moved:

```
20251014T105747 unify-workspace-initialization.md
20251014T105903 bidirectional-markdown-sync.md
20251017T113727-disable-yxmlfragment.md
20251019T000000-replace-symbol-dispose-with-destroy.md
20251019T000001-type-safety-improvements-client.md
20251019T130000-dependency-testing-examples.md
20251019T140000-simplify-mcp-with-typebox.md
20251021T000003-standardize-storage-locations.md
20251021T000004-extract-storage-dir-constant.md
20251021T233339-refactor-cli-tests.md
20251022T174038-consolidate-cli-package.md
20251022T180000-markdown-index-serialization-refactor.md
20251022T220000-improve-actions-introspection.md
20251024T000000-parser-validation-refactor.md
20251024T120000-workspace-persistence-array.md
20251125T090506-async-destroy-cleanup.md
```

## Steps

1. Create the new directory: `packages/epicenter/specs/`
2. Move all files from `packages/epicenter/docs/specs/` to `packages/epicenter/specs/`
3. Remove the now-empty `packages/epicenter/docs/specs/` directory
4. If `packages/epicenter/docs/` is now empty, remove it too
5. Verify no broken references exist (grep for `docs/specs` in epicenter package)

## Commands

```bash
# Create new directory
mkdir -p packages/epicenter/specs

# Move all files
mv packages/epicenter/docs/specs/* packages/epicenter/specs/

# Remove empty directories
rmdir packages/epicenter/docs/specs
rmdir packages/epicenter/docs  # if empty

# Verify no broken references
grep -r "docs/specs" packages/epicenter/
```

## Verification

After migration:
- [ ] `packages/epicenter/specs/` exists and contains 16 files
- [ ] `packages/epicenter/docs/specs/` no longer exists
- [ ] No code references the old path
- [ ] Git shows the files as renamed (not deleted + added)

## Notes

- Use `git mv` if you want cleaner git history
- The `/docs/specs/` at the project root should NOT be moved (it's for cross-cutting specs)
- The `apps/whispering/specs/` is already correct and doesn't need changes
