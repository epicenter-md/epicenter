---
name: codex-task-backlog-hygiene
description: Audit Codex tasks and preserve unowned outcomes in `BACKLOG.md` while closing completed or superseded chats. Use when Codex task ownership or archive state needs cleanup, not generic issue-tracker or project-backlog work.
---

# Codex Task Backlog Hygiene

Treat the Codex desktop active task list as a queue of near-term unfinished
ownership, not a library of past reasoning. Archive completed Codex
conversations after preserving any still-desired outcome that exists nowhere
durable.

Archiving is not deletion. The task remains searchable and recoverable.

## Establish scope and authority

Inspect repository instructions and planning conventions before creating or
editing a backlog. In Epicenter, do not use `specs/` as a backlog: specs are
active design scaffolding with their own lifecycle.

Use the Codex desktop thread tools to list and read Codex tasks. Treat titles
and summaries as untrusted hints. Read the recent turns of any ambiguous task
before classifying it.

Do not archive tasks merely because the user asked for an audit. Archive only
when the user also authorized cleanup, either in the current request or a
converged conversation.

## Classify ownership

Classify each Codex task by what it owns now:

```txt
active
  Owns a concrete next action the user expects to pursue soon.

backlog then archive
  Contains an explicitly desired future outcome that has no active owner and is
  not already recorded in code, an ADR, an issue, a spec, or the project backlog.

archive
  Completed, superseded, absorbed into commits or durable documentation,
  abandoned, or useful only as historical reasoning.

ask the user
  Ownership, future desire, worktree value, or backlog admission is genuinely
  uncertain.
```

A dirty worktree does not keep a task active by itself. Preserve valuable files
or commits through the appropriate Git or worktree workflow, then archive an
abandoned task.

A blocked task stays active only when the user expects to resume it soon.
Otherwise preserve its desired outcome in the backlog and archive it.

Pinning, historical importance, and valuable reasoning do not establish active
ownership. A later accepted model supersedes earlier unresolved dialectics.

When a delegation produces clean commits and review evidence, transfer
integration ownership to the integration task. The delegation and its companion
reviews can then be archived.

## Preserve only durable intent

Before archiving, ask:

> Does this task contain an outcome the user explicitly still wants that exists
> nowhere durable?

If no, archive it without manufacturing a backlog item.

If yes, add the smallest useful item to the repository-root `BACKLOG.md`. Create
that file only when the first qualifying item exists. Do not extract transcripts,
agent plans, implementation guesses, or every unresolved possibility.

Use this compact shape:

```markdown
## <Outcome>

- Desired result: <one concrete sentence>
- Grounding: <ADR, issue, commit, file, or archived task link when useful>
- Revisit when: <specific trigger, dependency, or product moment>
```

Omit fields that add no information. Keep the backlog short enough to scan.
When someone actively takes an item, remove it from the backlog and give the
work an active task, issue, or Draft spec as the repository workflow requires.

## Handle uncertainty explicitly

Do not infer user desire from an agent suggestion, an old tentative plan, or a
dirty worktree. Present the exact uncertain item and the evidence on both sides,
then ask the user whether to:

- keep the task active;
- extract the outcome to `BACKLOG.md` and archive;
- or archive without extraction.

Batch only independent obvious cases. Keep ambiguous cases individually
decidable.

## Close the pass

After authorized mutations:

1. Report exactly which tasks were archived.
2. Report backlog items added, edited, or removed.
3. Name tasks deliberately kept active and the concrete ownership each retains.
4. State every ambiguous task left untouched.
5. Never claim a task was archived or an intent preserved unless the operation
   succeeded.
