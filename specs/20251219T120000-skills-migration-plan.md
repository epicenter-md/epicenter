# Skills Migration Plan

## Current State

You have 11 rule files in `rules/` that are loaded via `@rules/` references in AGENTS.md. This is a custom lazy-loading system that works well but isn't compatible with Claude.ai or the official Skills format.

## Claude Skills Format

Each skill requires:
- A folder with the skill name (hyphen-case)
- A `SKILL.md` file inside with YAML frontmatter (`name`, `description`) + markdown content
- The `name` field must match the folder name

## Migration Complexity Analysis

### Tier 1: Easy (Direct Copy): 5-10 min each

These are self-contained, domain-specific, and don't reference other rules:

| File | Lines | Why Easy |
|------|-------|----------|
| `styling.md` | 33 | Short, self-contained Tailwind guidelines |
| `posthog.md` | 49 | Project-specific but portable pattern |
| `github.md` | 101 | Self-contained issue response templates |
| `social-media.md` | 110 | Self-contained writing guidelines |
| `rust.md` | 148 | Tauri error handling pattern, standalone |
| `error-handling.md` | 149 | wellcrafted trySync/tryAsync, standalone |

**Migration**: Just add YAML frontmatter and move to `skills/[name]/SKILL.md`

### Tier 2: Moderate (Minor Adjustments): 10-15 min each

These have cross-references or need description refinement:

| File | Lines | Why Moderate |
|------|-------|--------------|
| `git.md` | 212 | Large but self-contained; needs clear trigger description |
| `typescript.md` | 213 | Self-contained but long; may benefit from splitting |
| `documentation.md` | 230 | Long, covers multiple concerns (voice, README, punctuation) |
| `svelte.md` | 256 | References `@rules/styling.md`; needs that reference updated |

**Migration**: Remove `@rules/` references, add frontmatter, possibly split large files

### Tier 3: Complex (Architectural Decision): 30+ min

| File | Lines | Why Complex |
|------|-------|-------------|
| `general-guidelines.md` | 74 | Currently "always loaded"; contains workflow, honesty, control flow |

**Problem**: Skills are opt-in by task relevance. `general-guidelines.md` is meant to always apply. Options:
1. Keep in AGENTS.md directly (not a skill)
2. Split into smaller skills that get triggered more often
3. Create a meta-skill that references core principles

## Recommended Migration Order

### Phase 1: Quick Wins (start here)

1. **styling**: Smallest, cleanest migration
2. **posthog**: Small, project-specific
3. **github**: Clear trigger ("when responding to GitHub issues")
4. **social-media**: Clear trigger ("when writing social media posts")

### Phase 2: Core Development Skills

5. **error-handling**: Clear trigger ("when using trySync/tryAsync")
6. **rust**: Clear trigger ("when handling Tauri/Rust errors")
7. **git**: Clear trigger ("when creating commits or PRs")

### Phase 3: Framework Skills

8. **typescript**: Consider splitting into sub-skills if too large
9. **svelte**: Remove `@rules/styling.md` reference after styling migrated

### Phase 4: Content Skills

10. **documentation**: Consider splitting (technical writing vs README vs punctuation)

### Phase 5: Architectural Decision

11. **general-guidelines**: Decide: keep in AGENTS.md or restructure

## Example Migration: styling.md → skills/styling/SKILL.md

**Before** (`rules/styling.md`):
```markdown
# Styling Guidelines

## Minimize Wrapper Elements
...
```

**After** (`skills/styling/SKILL.md`):
```markdown
---
name: styling
description: CSS and Tailwind styling best practices. Use when writing styles, creating components, or reviewing CSS/Tailwind code.
---

# Styling Guidelines

## Minimize Wrapper Elements
...
```

## File Structure After Migration

```
skills/
├── styling/
│   └── SKILL.md
├── posthog/
│   └── SKILL.md
├── github-issues/
│   └── SKILL.md
├── social-media/
│   └── SKILL.md
├── error-handling/
│   └── SKILL.md
├── rust-errors/
│   └── SKILL.md
├── git/
│   └── SKILL.md
├── typescript/
│   └── SKILL.md
├── svelte/
│   └── SKILL.md
└── documentation/
    └── SKILL.md

rules/
└── general-guidelines.md  # Keep here, referenced in AGENTS.md

AGENTS.md  # Updated to reference skills/ and keep general-guidelines
```

## AGENTS.md Changes Required

Replace `@rules/` references with skill discovery guidance:

**Before**:
```markdown
## Development Guidelines

Load these domain-specific guidelines only when working in their respective domains:

**Language & Framework:**

- TypeScript code style and best practices: @rules/typescript.md
- Svelte patterns, TanStack Query, component composition: @rules/svelte.md
```

**After**:
```markdown
## Development Guidelines

Skills are automatically discovered from `skills/`. Use them when working in their respective domains.

## General Guidelines

Read the following file immediately as it's relevant to all workflows: @rules/general-guidelines.md
```

## Todo Checklist

- [ ] Create `skills/` directory
- [ ] Migrate Phase 1 skills (styling, posthog, github, social-media)
- [ ] Test that skills are discovered correctly
- [ ] Migrate Phase 2 skills (error-handling, rust, git)
- [ ] Migrate Phase 3 skills (typescript, svelte)
- [ ] Migrate Phase 4 skills (documentation)
- [ ] Update AGENTS.md
- [ ] Decide on general-guidelines approach
- [ ] Clean up empty rules/ directory (keep README explaining migration)

## Open Questions

1. **Do you want to keep both systems?** You could have `skills/` for portable skills and `rules/` for project-specific instructions that don't fit the Skills model.

2. **Split large files?** typescript.md (213 lines) and documentation.md (230 lines) could become multiple skills:
   - `typescript` → `typescript-core`, `typescript-arktype`, `typescript-constants`
   - `documentation` → `technical-writing`, `readme-guidelines`, `punctuation`

3. **general-guidelines handling?** Options:
   - Keep inline in AGENTS.md
   - Create `core-workflow` skill that's always relevant
   - Split into smaller behavioral skills

## Review

_To be filled after migration_
