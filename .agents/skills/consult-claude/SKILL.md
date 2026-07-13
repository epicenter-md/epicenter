---
name: consult-claude
description: Give Claude one patient, read-only consultation from Codex. Use only when the user explicitly invokes $consult-claude for a bounded second opinion, one-off decision, architecture challenge, or adversarial review during the current task.
---

# Consult Claude

Turn Codex's current evidence into one decision-complete brief, run Claude as a read-only consultant, patiently supervise it, and verify the returned advice.

## Ground the brief

Read the sources Claude should not have to rediscover. Include only context that bears on the decision, but make the packet cold-start complete:

```txt
Mission:
  The one decision or question.

State:
  What exists and what has already been established.

Evidence:
  Exact excerpts, diffs, command output, paths, and durable decisions.
  Include content, not only paths, because Claude has no file tools.

Current read:
  Codex's provisional conclusion and reasoning.

Competing case:
  The strongest alternative or objection.

Challenge:
  What Claude should attack, disprove, compare, or improve.

Constraints:
  Product promises, ownership boundaries, security limits, and non-goals.

Deliverable:
  The answer shape that would help Codex decide.

Stop:
  Answer the bounded question. Do not implement or expand the task.
```

Thorough means decision-complete, not large. Do not dump the repository or delegate context gathering to Claude.

## Run one attached consultation

Resolve this skill's directory from its loaded `SKILL.md` path. Start `scripts/consult-claude.ts` in the task's working directory with a PTY, then write the complete brief to stdin followed by EOF. The runner accepts no prompt arguments and creates no files.

The runner uses Claude safe mode with no tools, plugins, hooks, MCP, project discovery, or persisted session. It emits progress on stderr and one normalized JSON result on stdout.

If command execution yields a live session, keep that session ID and poll it. Never launch a duplicate consultation because the first one is quiet.

## Wait patiently

- Treat no answer text as slow, not hung.
- Poll the existing command session at reasonable intervals.
- Keep the user updated at least once per minute with elapsed time and the latest lifecycle event.
- Continue through reported retries or rate limits.
- Do not cancel because thinking is expensive, output is quiet, or Codex has formed its own answer.
- Cancel when the user changes direction or the consultation is no longer relevant.
- Let the runner enforce its hard timeout and terminate the Claude process group.

Do not add detached jobs, status files, session resume, or wrapper lifecycle subcommands. Codex's command session already owns waiting and cancellation.

## Reconcile the result

After a successful result:

1. Report Claude's recommendation accurately.
2. Separate evidence from opinion.
3. Verify every material claim against local files, tests, or authoritative sources.
4. Explain what changed in Codex's reasoning, if anything.
5. Keep Codex's conclusion when Claude's objection does not survive verification.

One skill invocation may make several fresh consultations during the current task when each resolves a genuinely new decision. Codex owns the dialectic and may include a prior Claude answer in the next brief. Never resume a Claude session or let Claude accumulate hidden context.
