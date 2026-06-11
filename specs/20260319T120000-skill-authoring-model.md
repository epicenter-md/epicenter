# Skill Authoring Model

**Date**: 2026-03-19
**Status**: Draft
**Author**: AI-assisted

## Overview

Evolve the existing 45 flat SKILL.md skills into a structured authoring model that uses the agentskills.io specification's progressive disclosure, eliminates duplication between `.agents/skills/` and `.claude/skills/`, and maps skills naturally to the monorepo's packages and apps.

## Motivation

### Current State

45 skills in `.agents/skills/`, 44 mirrored in `.claude/skills/`. Every skill is a single `SKILL.md` file. No skill uses `references/`, `scripts/`, or `assets/`. 6 skills are sourced externally from `better-auth/skills` (tracked in `skills-lock.json`).

```
.agents/skills/svelte/SKILL.md     # 779 lines: loads entirely into context
.claude/skills/svelte/SKILL.md     # identical copy
```

This creates problems:

1. **Context waste**: The `svelte` skill at 779 lines exceeds the spec's 500-line / 5,000-token recommendation. When an agent activates it to handle a `$derived` question, it also loads shadcn patterns, loading states, and data-driven markup. None of which are relevant.
2. **Duplication**: Every skill is maintained in two places (`.agents/` and `.claude/`). Changes must be applied twice or they drift.
3. **No progressive disclosure**: The agentskills.io spec is designed around metadata → instructions → resources, loaded in stages. We load everything at once.
4. **No automation**: No skills use `scripts/` for validation or pattern checking, despite having well-defined conventions that could be machine-verified.

### Desired State

```
skills/                              # Single canonical source
├── svelte/
│   ├── SKILL.md                     # ~250 lines: core decisions, gotchas, when-to-use
│   └── references/
│       ├── tanstack-query-mutations.md
│       ├── shadcn-patterns.md
│       ├── reactive-state-pattern.md
│       ├── component-patterns.md
│       └── loading-empty-states.md
├── workspace-api/
│   ├── SKILL.md
│   └── references/
│       ├── table-crud-observation.md
│       └── migration-patterns.md
└── ...

.agents/skills/ → symlinks or generated from skills/
.claude/skills/ → symlinks or generated from skills/
```

## Research Findings

### agentskills.io Specification

The [Agent Skills specification](https://agentskills.io/specification) defines a skill as a directory containing:

| Component | Required | Purpose |
|-----------|----------|---------|
| `SKILL.md` | Yes | YAML frontmatter (name, description) + markdown instructions |
| `scripts/` | No | Executable code agents can run |
| `references/` | No | Documentation loaded on demand |
| `assets/` | No | Templates, schemas, static resources |

**Progressive disclosure model**:
1. **Discovery** (~100 tokens): Agent loads only `name` and `description` from frontmatter at startup
2. **Activation** (<5,000 tokens): Full `SKILL.md` body loaded when task matches
3. **Resources** (as needed): Files in `references/`, `scripts/`, `assets/` loaded only when referenced

**Key finding**: The spec recommends keeping `SKILL.md` under 500 lines. Our `svelte` skill is 779 lines, `workspace-api` is 397. The spec's `references/` directory is specifically designed for this overflow. Agents load reference files only when the SKILL.md tells them to.

**Implication**: We should break large skills into core SKILL.md + reference files, using conditional loading instructions like *"If working with TanStack Query mutations, read `references/tanstack-query-mutations.md`."*

### Frontmatter Fields

| Field | Required | Our Usage |
|-------|----------|-----------|
| `name` | Yes | ✅ All skills have this |
| `description` | Yes | ✅ All skills have this |
| `metadata` | No | ✅ Most have `author` and `version` |
| `license` | No | ❌ Not used (could add for published skills) |
| `compatibility` | No | ❌ Not used (could specify "Requires bun" etc.) |
| `allowed-tools` | No | ❌ Experimental, not used |

### Current Skill Taxonomy

Our 45 skills cluster into 5 natural categories:

| Category | Count | Examples | Maps To |
|----------|-------|---------|---------|
| **Library** (external framework knowledge) | ~12 | svelte, elysia, yjs, arktype, better-auth-* | External repos |
| **Package** (internal API docs) | ~6 | workspace-api, encryption, query-layer, services-layer | packages/* |
| **Convention** (cross-cutting rules) | ~12 | typescript, testing, error-handling, styling, control-flow | Everywhere |
| **Workflow** (processes) | ~8 | workflow, spec-execution, git, incremental-commits | Development processes |
| **Content** (writing/communication) | ~7 | writing-voice, social-media, technical-articles | User-facing text |

### Package-to-Skill Mapping

| Package/App | Primary Skill | Secondary Skills |
|---|---|---|
| `packages/workspace` | `workspace-api` | `yjs`, `arktype` |
| `packages/ui` | `svelte` (shadcn section) | `styling` |
| `packages/vault` | `encryption` |: |
| `packages/sync` | `yjs` | `workspace-api` |
| `apps/api` | `elysia` | `better-auth-*`, `drizzle-orm` |
| `apps/whispering` | `tauri` | `svelte`, `workspace-api` |
| `apps/honeycrisp` | *(no dedicated skill)* | `svelte`, `workspace-api` |
| `apps/tab-manager` | *(no dedicated skill)* | `svelte`, `workspace-api` |

Convention skills (typescript, testing, error-handling, git) don't map to specific folders. They apply everywhere and are loaded based on task type.

### External Skill Sources

`skills-lock.json` already tracks 6 skills from `better-auth/skills`:

```json
{
  "better-auth-best-practices": { "source": "better-auth/skills", "sourceType": "github" },
  "better-auth-security-best-practices": { "source": "better-auth/skills", "sourceType": "github" },
  "create-auth-skill": { "source": "better-auth/skills", "sourceType": "github" },
  "email-and-password-best-practices": { "source": "better-auth/skills", "sourceType": "github" },
  "organization-best-practices": { "source": "better-auth/skills", "sourceType": "github" },
  "two-factor-authentication-best-practices": { "source": "better-auth/skills", "sourceType": "github" }
}
```

This is the "shadcn for skills" model: source code installed from external repos, tracked locally, customizable after install.

### MCP Tools in Skills

The agentskills.io spec has one experimental field: `allowed-tools` (space-delimited list of pre-approved tools). This varies by agent implementation. Most "tool" functionality in skills comes from:

- **`scripts/`**: Bundled executable scripts the agent runs (bun scripts, shell scripts)
- **`references/`**: Reference material loaded on demand
- **The SKILL.md body itself**: Instructions guiding the agent to use its existing tools

There's no standard for embedding MCP server definitions in skills. For project-specific tooling, `scripts/` is the right answer. Validation scripts, pattern checkers, template generators that run via `bun run`.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Canonical source location | `.agents/skills/` (existing) | Both OpenCode and VS Code/Copilot already look here. No migration needed. |
| Duplication elimination | Sync script copies `.agents/skills/` → `.claude/skills/` | `.claude/` is the secondary consumer. A simple `scripts/sync-skills.ts` keeps them in sync. |
| Category subdirectories | No: keep flat skill list | Agent discovery works on flat lists. Categories are a human concern documented in this spec, not directory structure. |
| Progressive disclosure | Yes: `references/` for large skills | Immediate context savings. The `svelte` skill alone drops from ~779 to ~250 tokens on activation. |
| Scripts | Future: add as conventions mature | Don't add empty `scripts/` directories. Add them when there's actual validation logic to bundle. |
| Reference file naming | `kebab-case.md` matching the topic | Consistent with skill directory naming. Referenced from SKILL.md with relative paths. |
| Cross-references between skills | Keep existing `> **Related Skills**: See \`skill-name\`` pattern | Already works, agents understand it, no tooling needed. |

## Architecture

```
SKILL AUTHORING MODEL
═══════════════════════

                    ┌─────────────────────────────────────────────┐
                    │          .agents/skills/ (canonical)         │
                    │                                             │
                    │  svelte/                                    │
                    │  ├── SKILL.md          (~250 lines)         │
                    │  └── references/                            │
                    │      ├── tanstack-query-mutations.md        │
                    │      ├── shadcn-patterns.md                 │
                    │      ├── reactive-state-pattern.md          │
                    │      ├── component-patterns.md              │
                    │      └── loading-empty-states.md            │
                    │                                             │
                    │  workspace-api/                             │
                    │  ├── SKILL.md          (~200 lines)         │
                    │  └── references/                            │
                    │      ├── table-crud-observation.md          │
                    │      ├── migration-patterns.md              │
                    │      └── document-content.md                │
                    │                                             │
                    │  typescript/                                │
                    │  └── SKILL.md          (flat, <500 lines)   │
                    │                                             │
                    │  better-auth-*/  (from skills-lock.json)    │
                    │  └── SKILL.md                               │
                    └──────────────┬──────────────────────────────┘
                                   │
                    scripts/sync-skills.ts
                                   │
                    ┌──────────────▼──────────────────────────────┐
                    │          .claude/skills/ (synced copy)       │
                    │  (identical structure, auto-generated)       │
                    └─────────────────────────────────────────────┘
```

### Progressive Disclosure Flow

```
AGENT STARTUP
─────────────
  Load name + description from all 45 skills (~100 tokens each)
  Total: ~4,500 tokens for skill discovery

USER ASKS: "Write a Svelte component with a mutation"
────────────────────────────────────────────────────────
  1. Agent matches "Svelte" + "mutation" → activates svelte skill
  2. Loads svelte/SKILL.md (~250 lines, ~2,500 tokens)
     - Core patterns, $derived, reactive state conventions
     - Cross-references: "See references/tanstack-query-mutations.md"
  3. Agent reads references/tanstack-query-mutations.md (~150 lines)
     - createMutation pattern, direct mutation calls in .ts files, `.fetch()` and `.ensure()` for queries, onSuccess/onError

  TOTAL CONTEXT: ~4,000 tokens (vs ~7,800 tokens loading everything)

USER ASKS: "Fix the TypeScript type error"
──────────────────────────────────────────
  1. Agent matches "TypeScript" → activates typescript skill
  2. Loads typescript/SKILL.md (flat, no references needed)

  TOTAL CONTEXT: ~3,000 tokens
```

### SKILL.md Internal Structure Convention

Every SKILL.md should follow this structure:

```markdown
---
name: skill-name
description: What it does and when to use it. Include trigger keywords.
metadata:
  author: epicenter
  version: '1.0'
---

# Skill Title

## Reference Repositories
- [Repo](url): one-line description

> **Related Skills**: See `other-skill` for X. See `another-skill` for Y.

## When to Apply This Skill
- Bullet list of trigger conditions

## Core Patterns
[The essential knowledge that loads on every activation]

## Gotchas
[Non-obvious things the agent will get wrong without being told]

## References
[Conditional loading instructions]
- If working with X, read [references/x.md](references/x.md)
- If working with Y, read [references/y.md](references/y.md)
```

### Reference File Structure

Each reference file is standalone. It should make sense without reading the parent SKILL.md:

```markdown
# Topic Title

## When to Read This
[One sentence: what task triggers loading this file]

## Patterns
[The actual content: code examples, rules, anti-patterns]
```

## Implementation Plan

### Phase 1: Proof of Concept: Svelte Skill

- [x] **1.1** Break `svelte/SKILL.md` (779 lines) into core SKILL.md + 5 reference files
- [x] **1.2** Verify all content is preserved (no information loss)
- [x] **1.3** Sync to `.claude/skills/`

### Phase 2: All Skills >300 Lines

- [x] **2.1** `typescript/SKILL.md` (874 → 225 lines, 5 refs)
- [x] **2.2** `services-layer/SKILL.md` (619 → 171 lines, 4 refs)
- [x] **2.3** `git/SKILL.md` (562 → 137 lines, 3 refs)
- [x] **2.4** `query-layer/SKILL.md` (474 → 175 lines, 3 refs)
- [x] **2.5** `testing/SKILL.md` (438 → 159 lines, 3 refs)
- [x] **2.6** `error-handling/SKILL.md` (412 → 183 lines, 3 refs)
- [x] **2.7** `workspace-api/SKILL.md` (397 → 157 lines, 3 refs)

### Phase 3: Sync Script

- [x] **3.1** Write `scripts/sync-skills.ts`
- [x] **3.2** Add `sync-skills` to `bun run` scripts in root `package.json`
- [x] **3.3** Run sync: 46 skills synced to `.claude/skills/`

### Phase 4: Scripts (Future)

- [ ] **4.1** Identify conventions that can be machine-verified
- [ ] **4.2** Add `scripts/` to skills with validation logic

## Open Questions

1. **Should the canonical source move to a top-level `skills/` directory?**
   - Options: (a) Keep `.agents/skills/` as canonical, (b) Move to `skills/` and sync to both `.agents/` and `.claude/`
   - **Recommendation**: Keep `.agents/skills/` as canonical. It already works with OpenCode and VS Code. Moving adds a sync step to both directories instead of one. Revisit if a third agent directory appears.

2. **Should we add `compatibility` fields?**
   - Some skills assume `bun` (e.g., `monorepo` skill). The spec supports a `compatibility` field.
   - **Recommendation**: Defer. Our skills are all project-specific. The project already requires bun.

3. **Should we publish skills for other Epicenter users?**
   - The `skills-lock.json` pattern (install from GitHub) already works for consuming external skills. Publishing our skills would mean maintaining them as a public API.
   - **Recommendation**: Defer until demand exists. The `workspace-api` and `encryption` skills could be valuable to contributors, but the authoring model should stabilize first.

4. **How should we handle the `.claude/skills/` duplication long-term?**
   - Options: (a) Sync script, (b) Symlinks, (c) `.claude/` config that points to `.agents/skills/`
   - **Recommendation**: Start with a sync script. Symlinks can break on some platforms. If Claude Code adds a config option to point to a custom skills directory, switch to that.

## Success Criteria

- [x] All 8 split skills have core SKILL.md under 250 lines
- [x] Reference files are self-contained with `# Title` and `## When to Read This`
- [x] Each SKILL.md includes conditional loading instructions
- [x] `.agents/skills/` and `.claude/skills/` are in sync (46 skills each)
- [ ] Agent behavior is unchanged (same patterns activated for the same tasks)

## References

- `agentskills.io/specification`: The Agent Skills format specification
- `agentskills.io/skill-creation/best-practices`: Skill authoring best practices
- `.agents/skills/svelte/SKILL.md`: Current 779-line skill (proof-of-concept target)
- `.agents/skills/workspace-api/SKILL.md`: Current 397-line skill (phase 2 target)
- `skills-lock.json`: External skill tracking

## Review

### Summary of Changes

Split 8 skills from monolithic SKILL.md files into core + progressive disclosure `references/` following the agentskills.io specification. Added `scripts/sync-skills.ts` to eliminate duplication between `.agents/skills/` and `.claude/skills/`.

### Line Count Results

| Skill | Before | After (core) | References | Context Savings |
|-------|--------|-------------|------------|-----------------|
| svelte | 779 | 130 | 5 files (685 lines) | 83% on activation |
| typescript | 874 | 225 | 5 files (691 lines) | 74% on activation |
| services-layer | 619 | 171 | 4 files (475 lines) | 72% on activation |
| git | 562 | 137 | 3 files (448 lines) | 76% on activation |
| query-layer | 474 | 175 | 3 files (320 lines) | 63% on activation |
| testing | 438 | 159 | 3 files (302 lines) | 64% on activation |
| error-handling | 412 | 183 | 3 files (252 lines) | 56% on activation |
| workspace-api | 397 | 157 | 3 files (263 lines) | 60% on activation |
| **Total** | **4,555** | **1,337** | **29 files** | **71% average** |

### What Changed

- 8 skills split into core SKILL.md + `references/` directories
- 29 new reference files created across those 8 skills
- `scripts/sync-skills.ts` added (86 lines)
- `package.json` updated with `sync-skills` script
- `.claude/skills/` synced from `.agents/skills/` (46 skills)
- 6 better-auth skills untouched (externally sourced)
- 30 skills under 300 lines untouched (appropriate size already)
