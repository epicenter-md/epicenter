---
name: spec-execution
description: Execute a specification document through planned waves of parallel and sequential changes, updating the spec and committing after each wave. Use when given a spec to implement, executing a planning document, or told to "execute this spec".
metadata:
  author: epicenter
  version: '1.0'
---

# Spec Execution

When handed a specification document (a `specs/*.md` file), execute it methodically in waves. Each wave produces working code, an updated spec, and a commit. The goal is a clean git history where each commit represents a coherent unit of progress against the spec.

## When to Apply This Skill

Use this pattern when you need to:

- Implement a `specs/*.md` plan end-to-end in structured waves.
- Decide which spec tasks run in parallel vs sequentially.
- Update spec checkboxes and implementation notes after each wave.
- Commit code changes together with spec progress for every wave.
- Finish execution by setting spec status and adding a review section.

## The Execution Loop

```
READ SPEC
    ↓
PLAN WAVES (which tasks are parallel vs sequential?)
    ↓
┌─── WAVE N ──────────────────────────────────────┐
│  1. Execute tasks (sub-agents for ALL tasks)     │
│  2. Verify (type-check, tests if applicable)     │
│  3. Update spec (check off items, add notes)     │
│  4. Commit (code changes + spec updates)         │
└──────────────────────────────────────────────────┘
    ↓
REPEAT until spec is complete
    ↓
FINAL REVIEW (update spec status, add review section)
```

## Phase 1: Read and Understand

Before touching any code:

1. **Read the entire spec** — understand the full scope before planning
2. **Identify the implementation phases** from the spec's Implementation Plan section
3. **Map dependencies** — which tasks block others? Which are independent?
4. **Check the spec's Open Questions** — resolve what you can, flag what needs human input

If the spec has unresolved Open Questions that block implementation, surface them immediately. Don't guess on architectural decisions.

## Phase 2: Plan Waves

Break the spec's implementation plan into execution waves. A wave is a set of changes that can be made together without breaking anything.

### Deciding Parallel vs Sequential

Every task runs in a sub-agent regardless. The question is only whether sub-agents run concurrently or one-at-a-time.

| Condition | Ordering |
| --- | --- |
| Tasks touch different files/modules | Parallel |
| Task B imports from Task A's output | Sequential (A before B) |
| Tasks modify the same file | Sequential (avoid conflicts) |
| Tasks are in different spec phases | Sequential (phase order) |
| Tasks within a phase are independent | Parallel |

### Wave Planning Checklist

Before executing, write out your wave plan:

```
Wave 1: [Foundation — types and interfaces]
  - Task 1.1 (parallel with 1.2)
  - Task 1.2 (parallel with 1.1)

Wave 2: [Core logic — depends on Wave 1 types]
  - Task 2.1 (sequential — modifies shared module)
  - Task 2.2 (after 2.1 — uses its exports)

Wave 3: [Integration — consumers of Wave 2]
  - Task 3.1 (parallel with 3.2)
  - Task 3.2 (parallel with 3.1)
```

Present this plan to the user before executing. Get a thumbs up.

## Phase 3: Execute Waves

For each wave:

### 1. Execute Tasks

**Every task gets its own sub-agent.** This is non-negotiable. Sub-agents exist to scope context — each one sees only what it needs for its task, which produces better results than a single agent juggling everything. Parallelism is a bonus, not the reason for sub-agents.

- **Independent tasks**: Launch sub-agents in parallel. Each gets a focused prompt with only the context it needs — the relevant spec section, the files to modify, and the patterns to follow.
- **Dependent tasks**: Launch sub-agents sequentially. Wait for one to complete before launching the next. The second agent gets the output/context from the first.
- **Keep changes minimal**: Each task should do exactly what the spec says. No bonus refactors, no "while I'm here" improvements.

### 2. Verify the Wave

After all tasks in a wave complete:

```bash
bun run tsc --noEmit          # type-check
bun test                       # if tests exist for changed code
```

If verification fails, fix issues before proceeding. Don't carry broken state into the next wave.

### 3. Update the Spec

Check off completed items in the spec's Implementation Plan:

```markdown
- [x] **1.1** Add IconDefinition type ← was [ ], now [x]
- [x] **1.2** Add CoverDefinition type
- [ ] **2.1** Update factory functions  ← not yet
```

If implementation deviated from the spec (it often does), add a note:

```markdown
- [x] **1.1** Add IconDefinition type
  > **Note**: Used discriminated union instead of enum as originally planned.
  > Rationale: better type narrowing in consumers.
```

If you discovered something during implementation, add it to the spec's Research Findings or Edge Cases section.

### 4. Commit the Wave

Each commit includes BOTH the code changes AND the spec updates. This means every commit in the history shows what was planned and what was actually done.

Follow `git` and `incremental-commits` skill conventions:

```
feat(scope): wave description — what this wave accomplishes

- Completed spec items 1.1, 1.2
- [Any notable deviations or discoveries]
```

Stage specific files — never `git add .` or `git add -A`.

## Phase 4: Final Review

After all waves complete:

1. **Update spec status** from "In Progress" to "Implemented"
2. **Add a Review section** at the bottom of the spec:

```markdown
## Review

**Completed**: [Date]
**Branch**: [branch-name]

### Summary

[2-3 sentences on what was built and how it differs from the original plan]

### Deviations from Spec

- [What changed and why]

### Follow-up Work

- [Anything discovered during implementation that should be a future spec]
```

3. **Final commit** with the review section added

## Sub-Agent Prompts

Every task — parallel or sequential — runs in a sub-agent. The primary agent orchestrates: it plans waves, launches sub-agents, verifies results, updates the spec, and commits. It does not implement code directly.

When spinning up sub-agents, each agent needs:

- **The specific spec section** it's implementing (not the whole spec)
- **The files it should read** before making changes
- **The files it should modify** (and only those files)
- **The patterns to follow** (reference relevant skills)
- **What NOT to do** — stay in lane, don't touch other files

Keep sub-agent prompts focused. A sub-agent that knows too much will try to do too much.

## When Things Go Wrong

| Situation | Response |
| --- | --- |
| Type-check fails after a wave | Fix before committing. Don't carry broken state. |
| Sub-agent made changes outside its scope | Revert the out-of-scope changes. Keep only what was asked for. |
| Spec item is ambiguous mid-implementation | Stop. Ask the user. Add clarification to the spec. |
| Discovery invalidates a later spec phase | Update the spec's plan. Inform the user. Re-plan remaining waves. |
| Tests fail | Fix the tests or the code. Update spec if the test failure reveals a spec gap. |

## Anti-Patterns

### Execute Without Planning

```
"Let me just start implementing..."
```

No. Read the spec. Plan waves. Get approval. Then execute.

### Giant Wave

```
Wave 1: Implement everything in the spec
```

If a wave touches more than 5-8 files, it's too big. Break it down.

### Spec Drift

```
Code diverges from spec but spec is never updated
```

The spec is a living document. Every commit should leave the spec accurate to what was actually built.

### Over-Parallel

```
Wave 1: 12 sub-agents all running at once
```

More than 3-4 parallel sub-agents gets chaotic. Group related tasks and keep parallelism manageable.

## Quick Reference

Before starting:

- [ ] Read entire spec
- [ ] Identify phases and dependencies
- [ ] Plan waves (parallel vs sequential)
- [ ] Present plan to user

For each wave:

- [ ] Execute tasks (every task in a sub-agent)
- [ ] Verify (type-check, tests)
- [ ] Update spec (check items, add notes)
- [ ] Commit (code + spec together)

After all waves:

- [ ] Update spec status to Implemented
- [ ] Add Review section
- [ ] Final commit
