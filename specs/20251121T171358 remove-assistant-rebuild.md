# Epicenter Assistant Removal and Rebuild Plan

**Created:** 2025-11-21T17:13:58
**Status:** Planning

## Context

The CORS support PR (sst/opencode#1218) that Epicenter Assistant was waiting for has already been merged to the OpenCode main branch in a simpler implementation. The OpenCode team implemented CORS using Hono's built-in middleware with permissive defaults, making our configurable approach unnecessary.

Since the Assistant is still unstable and we want to rebuild it properly, this plan outlines a two-phase approach:
1. Update documentation and remove the Assistant package from main
2. Rebuild the Assistant on a dedicated feature branch

## Goals

1. Remove references to waiting on the CORS PR (it's already merged)
2. Clean up the main branch by removing the incomplete Assistant package
3. Set up clear communication about the Assistant being rebuilt
4. Create a clean slate for rebuilding the Assistant properly

## Two-Phase Approach

### Phase 1: Documentation Update and Package Removal

This phase involves two separate pull requests to keep changes focused and reviewable.

#### PR #1: Update README - Remove CORS Wait Message

**Branch:** `update-cors-readme` (current branch)

**Changes:**
- [x] Update README.md line 85-86 to remove "(currently unstable, waiting for this PR in OpenCode to merge)"
- [x] Update the Assistant description to indicate it's being rebuilt
- [x] Add note directing users to the rebuild branch (once created in Phase 2)
- [x] Keep the link to `apps/sh` for now since we haven't deleted it yet

**New text for lines 83-89:**
```markdown
<h3>🤖 <a href="https://github.com/EpicenterHQ/epicenter/tree/main/apps/sh">Epicenter Assistant</a></h3>
<p><em>Currently being rebuilt from the ground up.</em></p>
<p>A local-first assistant you can chat with. It lives in your folder, becoming the access point to everything you've ever written, thought, or built.</p>
<p><strong>→ Track rebuild progress on the <a href="https://github.com/EpicenterHQ/epicenter/tree/rebuild-assistant">rebuild-assistant branch</a></strong></p>
```

#### PR #2: Remove Assistant Package

**Branch:** `remove-assistant-package`

**Changes:**
- [x] Delete entire `apps/sh/` directory
- [x] Remove `@epicenter/sh` references from root `package.json` (workspace pattern handles this automatically)
- [x] Remove `@epicenter/sh` from `turbo.json` if present (no references found)
- [x] Update README.md to remove the link to `apps/sh` (since it won't exist)
- [x] Check for and remove any other references to `apps/sh` in:
  - [x] `.github/` workflows (no references found)
  - [x] Documentation in `docs/` (only in this spec file)
  - [x] `apps/epicenter/src/pages/index.astro` (updated to point to rebuild branch)

**Updated README text (after removal):**
```markdown
<h3>🤖 Epicenter Assistant</h3>
<p><em>Currently being rebuilt from the ground up.</em></p>
<p>A local-first assistant you can chat with. It lives in your folder, becoming the access point to everything you've ever written, thought, or built.</p>
<p><strong>→ Track rebuild progress on the <a href="https://github.com/EpicenterHQ/epicenter/tree/rebuild-assistant">rebuild-assistant branch</a></strong></p>
```

### Phase 2: Rebuild on Feature Branch

**Branch:** `rebuild-assistant` (to be created from main after Phase 1 merges)

This will be a separate effort after Phase 1 is complete. The branch will:
- Start with a clean slate
- Implement Assistant functionality without waiting on external dependencies
- Use the already-merged CORS support in OpenCode
- Follow proper incremental development with reviewable commits

## Success Criteria

### Phase 1 Success:
- [ ] README accurately reflects that CORS PR is no longer a blocker
- [ ] Users know the Assistant is being rebuilt and where to track it
- [ ] Main branch is clean without incomplete Assistant code
- [ ] All references to `apps/sh` are removed or updated appropriately

### Phase 2 Success (Future):
- [ ] New Assistant implementation on `rebuild-assistant` branch
- [ ] Properly integrated with OpenCode's CORS support
- [ ] Incremental, reviewable development
- [ ] Clear documentation of functionality

## Implementation Order

1. **Now:** PR #1 (update README about CORS)
   - Update documentation to remove CORS blocker message
   - Add rebuild branch reference
   - Get this merged to main

2. **Next:** PR #2 (remove Assistant package)
   - Delete `apps/sh/` entirely
   - Remove all references
   - Clean up configuration files
   - Get this merged to main

3. **Later:** Create `rebuild-assistant` branch from main
   - Fresh start for Assistant implementation
   - Proper incremental development
   - This will be tracked separately

## Review

### What Was Completed

Both phases of the plan have been successfully executed:

#### PR #1: Update CORS readme (Branch: `update-cors-readme`)
- ✅ Removed the "currently unstable, waiting for this PR in OpenCode to merge" message
- ✅ Updated README to indicate Assistant is being rebuilt
- ✅ Added reference to `rebuild-assistant` branch for tracking progress
- ✅ Committed and pushed to remote
- 🔗 Ready for review at: https://github.com/EpicenterHQ/epicenter/pull/new/update-cors-readme

#### PR #2: Remove assistant package (Branch: `remove-assistant-package`)
- ✅ Deleted entire `apps/sh/` directory (87 files removed, ~12k lines deleted)
- ✅ Updated README to remove broken `apps/sh` link
- ✅ Updated `apps/epicenter/src/pages/index.astro` to point to rebuild branch
- ✅ Verified no references in GitHub workflows
- ✅ Verified no explicit references in config files (workspace pattern handles removal)
- ✅ Committed and pushed to remote
- 🔗 Ready for review at: https://github.com/EpicenterHQ/epicenter/pull/new/remove-assistant-package

### Key Findings

1. **No Configuration Changes Needed**: The monorepo uses a workspace pattern (`apps/*`) in `package.json`, which automatically handled the removal without explicit configuration changes.

2. **Clean Separation**: The Assistant package was well-isolated; no other apps or packages had direct dependencies on it.

3. **Documentation References**: Found references in:
   - Main README (updated)
   - Landing page at `apps/epicenter/src/pages/index.astro` (updated)
   - Various spec documents (kept as historical record)
   - `bun.lock` (will be updated automatically on next `bun install`)

### Next Steps

1. **Review and merge PR #1**: Update CORS documentation
2. **Review and merge PR #2**: Remove Assistant package
3. **Create `rebuild-assistant` branch**: Start fresh implementation from main
4. **Implement Assistant v2**: Clean slate for proper implementation with OpenCode's built-in CORS support

### Recommendations

- Consider documenting the decision to rebuild in a blog post or changelog
- When creating the `rebuild-assistant` branch, start with a clear spec document outlining the new architecture
- Take advantage of lessons learned from the first implementation

## Notes

- Both PRs should be kept small and focused
- PR #1 can be merged independently
- PR #2 should wait until we're ready to commit to removing the package
- The rebuild branch will allow experimentation without affecting main
- Users following the project will have clear visibility into the rebuild progress
