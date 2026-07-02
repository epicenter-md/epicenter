---
name: spec-execution
description: Execute `specs/*.md` plans through working checkpoints. Use when the user says "execute this spec", "implement this plan", "run the spec", or points at a spec file.
metadata:
  author: epicenter
  version: '1.0'
---

# Spec Execution

When handed a specification document (a `specs/*.md` file), execute it methodically in waves. A wave is an implementation checkpoint: after it lands, the repo should build, relevant tests should pass, and the spec should describe what is now true.

Commits should follow the shape of the work. Commit after a wave when that wave is a natural review unit. Combine waves into one larger commit when the changes are tightly coupled. Break a large wave into smaller commits when that makes the history easier to audit. The goal is working checkpoints first, readable git history second.

## The Execution Loop

```
PREFLIGHT SPEC
    |
    v
READ ACTIVE PATH
    |
    v
PLAN WAVES (which tasks are parallel vs sequential?)
    |
    v
WAVE N
  1. Execute tasks (sub-agents when useful)
  2. Verify (type-check, tests if applicable)
  3. Update spec (check off items, add notes)
  4. Commit or checkpoint, based on review shape
    |
    v
REPEAT until spec is complete
    |
    v
FINAL REVIEW (post-implementation-review, harvest decisions to docs/adr/, delete spent spec)
```

Default to continuing. After a wave passes verification, move to the next
unchecked item until the spec is complete. Ask the user only when continuing
requires a product decision, destructive action, broad reshape, or resolving a
conflict with current code.

## Phase 0: Preflight the Spec

Before planning waves, make sure the spec has a current execution path.

Check:

- Status: Draft or In Progress. A spec is in-flight; "done" is deletion, not a terminal status (see `specs/README.md`).
- Supersession: whether the top of the spec points to a newer spec.
- One Sentence: what the spec is actually about.
- Current State and Target Shape: enough concrete code, routes, types, or file paths to start.
- Implementation Plan: actionable tasks or waves.
- Verification: commands, smoke tests, or grep checks that prove the work.
- Open Questions: anything that blocks implementation.

Large specs are fine. Do not split or reject a spec because it is long. Only stop to refresh the spec when the active path is unclear, stale, or mixed with unrelated reader jobs.

If a spec is long but usable, write a short wave plan and proceed. If it is long and confusing, first add or update a "How to read this spec" or "Active execution path" section. That update is part of the work.

## Phase 1: Read and Understand

Before touching any code:

1. **Read the active path first**: understand what is current before reading appendices, prompts, or historical notes
2. **Identify the implementation phases** from the spec's Implementation Plan section
3. **Map dependencies**: which tasks block others? Which are independent?
4. **Check the spec's Open Questions**: resolve what you can, flag what needs human input
5. **Scan the rest of the spec for constraints**: read decisions, rejected alternatives, and edge cases that could affect the implementation

If the spec has unresolved Open Questions that block implementation, surface them immediately. Don't guess on architectural decisions.

## Phase 2: Plan Waves

Break the spec's implementation plan into execution waves. A wave is a set of changes that can land together while leaving the repo working.

Breaking API changes are allowed inside a wave. The boundary matters: by the end of the wave, update affected consumers, migrations, tests, or documentation so the repo is coherent again.

### Deciding Parallel vs Sequential

Use sub-agents whenever the runtime permits and the task has a clean ownership boundary. The question is whether each task is small, bounded, and non-overlapping enough to delegate safely, and whether delegated tasks should run concurrently or sequentially.

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
Wave 1: [Foundation, types and interfaces]
  - Task 1.1 (parallel with 1.2)
  - Task 1.2 (parallel with 1.1)
  - Checkpoint: verify and update spec
  - Commit: optional, if this is a reviewable unit

Wave 2: [Core logic, depends on Wave 1 types]
  - Task 2.1 (sequential, modifies shared module)
  - Task 2.2 (after 2.1, uses its exports)
  - Checkpoint: verify and update spec
  - Commit: likely, because this changes behavior

Wave 3: [Integration, consumers of Wave 2]
  - Task 3.1 (parallel with 3.2)
  - Task 3.2 (parallel with 3.1)
  - Checkpoint: verify and update spec
  - Commit: combine with Wave 2 if the API and consumers should be reviewed together
```

Proceed after planning. Ask first only for product choices, destructive actions, broad reshape risk, or conflicts with current code.

## Phase 3: Execute Waves

For each wave:

### 1. Execute Tasks

Use sub-agents for owned implementation work when they are available. They are strongest when each agent owns a bounded task, a clear file set, and a non-overlapping write surface. The primary agent still owns orchestration, integration, verification, spec updates, and final review.

- **Independent tasks**: Launch sub-agents in parallel when write sets do not overlap. Each gets a focused prompt with only the context it needs: the relevant spec section, the files it owns, and the patterns to follow.
- **Dependent tasks**: Launch sub-agents sequentially when one task imports from another task's output or modifies the same files. Wait for one to complete before launching the next. The second agent gets the output/context from the first.
- **Local tasks**: Keep work local when the task is tightly coupled, urgent, too ambiguous to delegate, or likely to block the next orchestration step.
- **Keep changes coherent**: Treat the spec as the execution spine, not a file whitelist. Implement the spec first; fix grounded correctness, verification, API, and serious clarity issues you uncover; record meaningful deviations.

### 2. Verify the Wave

After all tasks in a wave complete:

```bash
bun typecheck                 # repo-standard type-check
bun test                       # if tests exist for changed code
```

If verification fails, fix issues before proceeding. Don't carry broken state into the next wave.

### 3. Update the Spec

Check off completed items in the spec's Implementation Plan:

```markdown
- [x] **1.1** Add IconDefinition type
- [x] **1.2** Add CoverDefinition type
- [ ] **2.1** Update factory functions
```

If implementation deviated from the spec (it often does), add a note:

```markdown
- [x] **1.1** Add IconDefinition type
  > **Note**: Used discriminated union instead of enum as originally planned.
  > Rationale: better type narrowing in consumers.
```

If you discovered something during implementation, add it to the spec's Research Findings or Edge Cases section.

### 4. Commit or Checkpoint the Wave

Each committed unit should include BOTH the code changes AND the spec updates that describe those changes. This keeps history honest: each commit shows what was planned, what changed, and what was actually built.

You do not have to create one commit per wave; use the commit shape that best fits the review, as described at the top of this skill. If the user wants one large commit, keep intermediate working checkpoints and create one final commit at the end.

Follow `git` and `standalone-commits` skill conventions:

```
feat(scope): wave description, what this wave accomplishes

- Completed spec items 1.1, 1.2
- [Any notable deviations or discoveries]
```

Stage specific files. Never `git add .` or `git add -A`.

## Phase 4: Final Review

After all waves complete:

1. **Run `post-implementation-review`** against the files touched by the spec.
   Use the findings to clean up stale abstractions, dead paths, invariant drift,
   naming issues, and missing verification before handoff.
2. **Harvest durable decisions into `docs/adr/`.** A spec is scaffolding, not the
   durable record (see `specs/README.md` and the AGENTS.md routing). For each
   load-bearing decision the work settled (an architecture or ownership choice, an
   API shape, a rejected alternative worth not re-litigating), record it in
   `docs/adr/`:
   - If the spec already pointed at a `Proposed` ADR, flip it to `Accepted`.
   - Otherwise write a new ADR using `docs/adr/README.md`. Keep it to the one
     decision and its consequences; the spec held the exploration, the ADR holds
     the outcome.
   - A spec with no durable decision (a pure refactor or mechanical plan) needs no
     ADR. Not every spec earns one.
3. **Delete the spent spec.** Once its decisions are in ADRs and the work has
   landed, `git rm` the spec. Git keeps the body and `docs/spec-history.md` indexes
   it by date, so nothing is lost. Do not leave a finished spec in the tree as a
   knowledge base; that is the pollution this workflow exists to prevent.
4. **Verify hygiene.** Run `bun scripts/check-doc-hygiene.ts`. It must pass: no
   spec left in the tree declaring a terminal status, no `Proposed` ADR orphaned by
   a deleted spec. A failure means the harvest is incomplete; fix it (flip the ADR,
   delete the spec) rather than committing the smell.
5. **Final commit or final amend/squash** that includes the new or updated ADR and
   the spec deletion, matching the commit strategy chosen earlier.

The durable "why" now lives in the ADR; the "what landed" narrative belongs in the
pull request body. When writing the PR, load `git` and follow the PR narrative
guidance there. Nothing durable stays behind in the spec.

## Sub-Agent Prompts

The primary agent orchestrates: it plans waves, launches sub-agents when useful, verifies results, updates the spec, and commits. It may implement tightly coupled or blocking work directly when delegation would add coordination cost or risk.

When spinning up sub-agents, each agent needs:

- **The specific spec section** it's implementing (not the whole spec)
- **The files it should read** before making changes
- **The primary files it owns**
- **The patterns to follow** (reference relevant skills)
- **Questions that need the user**: product decisions, destructive actions, broad reshaping, or current-code conflicts

Keep sub-agent prompts focused. A sub-agent that knows too much will try to do too much.

## When Things Go Wrong

| Situation | Response |
| --- | --- |
| Type-check fails after a wave | Fix before moving on. Don't carry broken state. |
| Sub-agent changed files outside its owned lane | Inspect them. Revert speculative or unrelated edits. Keep grounded correctness or verification fixes, then record the deviation in the spec. |
| Spec item is ambiguous mid-implementation | Stop. Ask the user. Add clarification to the spec. |
| Discovery invalidates a later spec phase | Update the spec's plan. Inform the user. Re-plan remaining waves. |
| Tests fail | Fix the tests or the code. Update spec if the test failure reveals a spec gap. |

## Anti-Patterns

### Execute Without Planning

```
"Let me just start implementing..."
```

No. Read the spec, plan waves, then execute. Planning should start the work, not become a reason to stop.

### Giant Wave

```
Wave 1: Implement everything in the spec
```

If a wave touches more than 5-8 files, ask whether it still represents one coherent working checkpoint. Sometimes a broad breaking change needs to happen together, but default to smaller waves when reviewability or verification would improve.

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
