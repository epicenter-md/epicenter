# Specification and Prompt Organization Refactor

## Overview

This document analyzes the current organization of AI agent instructions (AGENTS.md, rules/, specs/) and proposes improvements based on best practices.

## Current State Analysis

### What You Have

**Entry Point System:**
- `CLAUDE.md` → references `@AGENTS.md`
- `AGENTS.md` → lazy-loads domain-specific rules via `@rules/filename.md`
- This pattern is **well-designed** and follows best practices for context management

**Rules Directory (11 files):**
```
rules/
├── README.md           # Documents the lazy-loading system
├── general-guidelines.md # Always loaded (workflow, honesty, control flow)
├── typescript.md       # Language: TypeScript patterns
├── svelte.md          # Framework: Svelte, TanStack Query
├── rust.md            # Language: Rust-to-TS error handling
├── error-handling.md  # Practice: wellcrafted trySync/tryAsync
├── git.md             # Workflow: commits, PRs
├── github.md          # Workflow: issue responses
├── posthog.md         # Tool: analytics integration
├── documentation.md   # Content: technical writing
└── social-media.md    # Content: social posts
```

**Specs Locations (123 total specs):**
- `/docs/specs/` - 99 files (general project specs)
- `/apps/whispering/specs/` - 8 files (app-specific)
- `/packages/epicenter/docs/specs/` - 16 files (package-specific)

**Git Worktree Pattern:**
- Each `.conductor/` branch has its own copy of `rules/`, `AGENTS.md`, `CLAUDE.md`
- This is inherent to how git worktrees work with committed files

### What's Working Well

1. **Lazy-loading pattern** - Domain-specific rules load only when needed, keeping context focused
2. **Clear categorization** - Rules organized by domain (Language, Practice, Workflow, Content)
3. **Single entry point** - AGENTS.md provides clear starting point
4. **Co-located specs** - Specs live near the code they describe

### Problems Identified

1. **Missing file**: `styling.md` referenced in AGENTS.md but doesn't exist
2. **No specs discoverability**: 123 specs across 3 locations with no index
3. **Unclear spec placement guidance**: When should specs go in which location?
4. **Potential content overlap**: Styling content exists in both `svelte.md` and your global `~/.claude/CLAUDE.md`
5. **Worktree drift risk**: Rules can diverge between branches without notice

---

## Research Findings

Based on research of AI prompt organization best practices:

| Practice | Your Status | Recommendation |
|----------|-------------|----------------|
| Lazy loading | ✅ Implemented | Keep |
| Modular files | ✅ Implemented | Keep |
| Hierarchical scoping | ⚠️ Partial | Consider nested AGENTS.md per app/package |
| Central registry/index | ❌ Missing | Add for specs |
| Clear placement rules | ❌ Missing | Document in general-guidelines.md |
| File size limits | ✅ Reasonable | Keep |

---

## Proposed Changes

### 1. Create Missing `styling.md`

**Why:** AGENTS.md references this file, causing confusion when it doesn't exist.

**Action:** Extract styling content from `svelte.md` into dedicated `rules/styling.md`:
- Minimize wrapper elements
- Tailwind best practices
- shadcn-svelte patterns
- CSS variables and theming

### 2. Add Specs Index

**Why:** 123 specs are hard to discover across 3 locations.

**Action:** Create `/docs/specs/INDEX.md` that:
- Lists all specs with one-line descriptions
- Groups by status (active, completed, archived)
- Links to specs in all three locations
- Auto-generated via script (optional future enhancement)

### 3. Document Spec Placement Rules

**Why:** No clear guidance on where new specs should go.

**Action:** Add to `general-guidelines.md`:

```markdown
## Spec Placement

- **`/docs/specs/`** - Cross-cutting features, architecture decisions, general tooling
- **`/apps/[app]/specs/`** - Features specific to one app only
- **`/packages/[pkg]/docs/specs/`** - Package-specific implementation details

When in doubt, use `/docs/specs/`. Move to app/package-specific only if the spec truly belongs there.
```

### 4. Add Worktree Sync Note

**Why:** Branches can drift, causing inconsistent behavior.

**Action:** Add to `rules/README.md`:

```markdown
## Git Worktree Considerations

Each git worktree (`.conductor/` branch) has its own copy of these rules. When updating rules:
1. Make changes in the branch you're working in
2. If the change should apply globally, merge to main and rebase other branches
3. Accept that experimental branches may have different rules temporarily
```

### 5. Clean Up Redundant Content (Optional)

**Why:** Your global `~/.claude/CLAUDE.md` duplicates content from these rules.

**Action:** Consider moving project-specific content from `~/.claude/CLAUDE.md` to the project's rules/ and keeping only truly personal preferences in the global file.

---

## Implementation Plan

- [x] 1. Create `rules/styling.md` - Extract from svelte.md
- [x] 2. Update `rules/svelte.md` - Remove styling content, add `@rules/styling.md` reference
- [ ] ~~3. Create `docs/specs/INDEX.md`~~ - Dropped; grep/search is sufficient
- [x] 4. Update `rules/general-guidelines.md` - Add spec placement rules
- [x] 5. Update `rules/README.md` - Add worktree sync note
- [ ] ~~6. Clean up `~/.claude/CLAUDE.md`~~ - Dropped; redundancy provides safety
- [x] 7. Create `apps/whispering/AGENTS.md` - Simple, bulleted
- [x] 8. Create `packages/epicenter/AGENTS.md` - Simple, bulleted

---

## Review

### Changes Made

1. **Created `rules/styling.md`**: New file containing CSS, Tailwind, and shadcn-svelte best practices extracted from svelte.md

2. **Updated `rules/svelte.md`**: Removed inline styling content (lines 109-207), replaced with reference to `@rules/styling.md`

3. **Updated `rules/general-guidelines.md`**: Added "Spec Placement" section documenting when to use each specs location

4. **Updated `rules/README.md`**: Added "Git Worktree Note" section explaining how rules work across conductor branches

5. **Created `apps/whispering/AGENTS.md`**: Minimal, bulleted guide covering three-layer architecture, Result types, and key don'ts

6. **Created `packages/epicenter/AGENTS.md`**: Minimal guide referencing existing CLAUDE.md for Bun specifics

### Decisions Made

- **Spec index**: Dropped; unnecessary overhead since grep/search handles discoverability
- **Global CLAUDE.md cleanup**: Dropped; redundancy provides safety net
- **Nested AGENTS.md**: Yes, created simple bulleted versions for whispering and epicenter
- **Specs location**: All specs at root level (`/specs/` not `/docs/specs/`) for consistency
- **styling.md scope**: Generic CSS/Tailwind only; shadcn-svelte content stays in svelte.md

### Files Changed (Round 1)

```
rules/styling.md          (new)
rules/svelte.md           (updated)
rules/general-guidelines.md (updated)
rules/README.md           (updated)
apps/whispering/AGENTS.md (new)
packages/epicenter/AGENTS.md (new)
```

### Files Changed (Round 2)

```
rules/styling.md          (updated - removed shadcn-svelte content)
rules/svelte.md           (updated - added shadcn-svelte content back)
rules/general-guidelines.md (updated - specs use /specs/ not /docs/specs/)
rules/README.md           (updated - styling.md description)
AGENTS.md                 (updated - styling.md description)
packages/epicenter/AGENTS.md (updated - specs path)
```

### Handoff Created

Migration spec created at `docs/specs/20251128T130000-migrate-specs-to-root-level.md` for another agent to move `packages/epicenter/docs/specs/` → `packages/epicenter/specs/`
