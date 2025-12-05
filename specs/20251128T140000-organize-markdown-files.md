# Organize Orphaned Markdown Files

## Problem Statement

Following PR #1030 which standardized specs to root-level directories, there are still some orphaned markdown files that need attention:

1. **Root-level orphan**: `why-min-width-zero-fixes-table-overflow.md` - an article that should be in `docs/`
2. **Loose files in `docs/`**: 15 markdown files sitting directly in `docs/` instead of being organized into subdirectories
3. **Outdated `docs/README.md`**: Still references `docs/specs/` which was moved to `/specs/`

## Current State

### Root Level Markdown Files
- `AGENTS.md` - agent configuration (keep at root)
- `CLAUDE.md` - agent configuration (keep at root)
- `CODE_OF_CONDUCT.md` - standard repo file (keep at root)
- `CONTRIBUTING.md` - standard repo file (keep at root)
- `README.md` - standard repo file (keep at root)
- `SECURITY.md` - standard repo file (keep at root)
- `why-min-width-zero-fixes-table-overflow.md` - **ORPHAN** (move to docs/)

### Loose Files in `docs/`
These 15 files should be organized into appropriate subdirectories:

| File | Suggested Location | Reason |
|------|-------------------|--------|
| `accessor-pattern-explained.md` | `docs/articles/` | Technical article |
| `bun-version-sync.md` | `docs/guides/` | CI/tooling guide |
| `date-with-timezone-implementation.md` | `docs/articles/` | Technical article |
| `download-streaming-approaches.md` | `docs/articles/` | Technical article |
| `ffmpeg-openai-compatibility.md` | `docs/guides/` | Compatibility guide |
| `generic-drilling-article.md` | `docs/articles/` | TypeScript article |
| `handoff-yjs-persistence-rollout.md` | `docs/guides/` | Rollout guide |
| `svelte-preloading-pattern.md` | `docs/patterns/` | Pattern documentation |
| `tauri-single-instance-fix.md` | `docs/articles/` | Technical article |
| `typescript-default-generics.md` | `docs/articles/` | TypeScript article |
| `v7.5.0-issue-responses.md` | `docs/releases/` or delete | Issue responses |
| `vault-core-diagram.md` | `docs/architecture/` | Architecture doc |
| `whispering-parakeet-integration.md` | `docs/guides/` | Integration guide |
| `why-callbacks-in-mutate.md` | `docs/patterns/` | Pattern documentation |
| `yjs-persistence-guide.md` | `docs/guides/` | Guide |

### Root Orphan
| File | Suggested Location | Reason |
|------|-------------------|--------|
| `why-min-width-zero-fixes-table-overflow.md` | `docs/articles/` | CSS technical article |

## Distinction Between `specs/` and `docs/`

### specs/ - Design Documents (Planning)
- Created BEFORE implementation begins
- Capture the "why" and "how" of design decisions
- Include todo checkboxes for implementation steps
- Timestamped for historical context
- May be incomplete; some get abandoned
- Purpose: Plan features and document decisions

### docs/ - Knowledge Articles (Reference)
- Created AFTER understanding or implementing something
- Capture patterns, techniques, and learnings
- Polished content meant to be read by others
- Organized by topic (articles, patterns, guides, etc.)
- Purpose: Share knowledge and best practices

### Quick Test
- "I'm about to implement X, let me think through the approach" → `specs/`
- "I learned something useful, let me document it" → `docs/`

## Recommended Changes

### Phase 1: Move Root Orphan
- [x] Move `why-min-width-zero-fixes-table-overflow.md` to `docs/articles/`

### Phase 2: Organize Loose docs/ Files
- [x] Move technical articles to `docs/articles/`
- [x] Move patterns to `docs/patterns/`
- [x] Move guides to `docs/guides/`
- [x] Move architecture docs to `docs/architecture/`
- [x] Move `v7.5.0-issue-responses.md` to `docs/release-notes/`

### Phase 3: Update References
- [x] Update `docs/README.md` to remove `/specs` reference and reflect new structure

## Question: Are specs or docs "ready to execute"?

Looking at recent specs:
- `20251218T194432 query-layer-commands-refactor.md` - Marked as **COMPLETED**
- `20251219T120345 bulk-file-upload.md` - Marked as **COMPLETED**
- Most recent specs appear to be completed or in-progress with their associated PRs

The specs folder looks well-maintained. The files there are historical records of completed work, not pending tasks.

## Review

All changes completed successfully. Summary of moves:

**To `docs/articles/` (7 files):**
- `why-min-width-zero-fixes-table-overflow.md` (from root)
- `accessor-pattern-explained.md`
- `date-with-timezone-implementation.md`
- `download-streaming-approaches.md`
- `generic-drilling-article.md`
- `tauri-single-instance-fix.md`
- `typescript-default-generics.md`

**To `docs/patterns/` (2 files):**
- `svelte-preloading-pattern.md`
- `why-callbacks-in-mutate.md`

**To `docs/guides/` (5 files):**
- `bun-version-sync.md`
- `ffmpeg-openai-compatibility.md`
- `handoff-yjs-persistence-rollout.md`
- `whispering-parakeet-integration.md`
- `yjs-persistence-guide.md`

**To `docs/architecture/` (1 file):**
- `vault-core-diagram.md`

**To `docs/release-notes/` (1 file):**
- `v7.5.0-issue-responses.md`

**Updated:**
- `docs/README.md` - Removed outdated `/specs` reference, documented all current subdirectories

---

## Phase 4: Organize `packages/epicenter/docs/`

The epicenter package also has 6 loose files in its `docs/` folder:

| File | Suggested Location | Reason |
|------|-------------------|--------|
| `column-schema-naming.md` | `docs/articles/` | Design decisions article |
| `versioning-philosophy.md` | `docs/articles/` | Design decisions article |
| `when-to-expand-generics.md` | `docs/articles/` | TypeScript patterns article |
| `workspace-ids-and-names.md` | `docs/articles/` | Design decisions article |
| `yarray-diff-sync.md` | `docs/articles/` | Technical article |
| `ytext-diff-sync.md` | `docs/articles/` | Technical article |

All 6 files are technical articles explaining design decisions or implementation approaches. They should all go into `articles/`.

### Phase 4 Tasks
- [x] Move all 6 loose files to `packages/epicenter/docs/articles/`

## Phase 5: Update AGENTS.md Files

Add clear documentation about specs and docs organization to all AGENTS.md files:

- [x] Update `/AGENTS.md` with specs/docs organization section
- [x] Update `/apps/whispering/AGENTS.md` with docs section
- [x] Update `/packages/epicenter/AGENTS.md` with docs section

## Phase 4-5 Review

**Moved to `packages/epicenter/docs/articles/` (6 files):**
- `column-schema-naming.md`
- `versioning-philosophy.md`
- `when-to-expand-generics.md`
- `workspace-ids-and-names.md`
- `yarray-diff-sync.md`
- `ytext-diff-sync.md`

**Updated AGENTS.md files:**
- Root `AGENTS.md` now has a complete "Specs and Docs Organization" section
- `apps/whispering/AGENTS.md` updated with simplified reference
- `packages/epicenter/AGENTS.md` updated with simplified reference

All AGENTS.md files now reference the root for the full organization guide, avoiding duplication.
